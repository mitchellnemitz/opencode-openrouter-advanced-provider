import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseTierArg, routerPluginId, tierPickerOptions, COST_TIERS } from "../src/tier.js";
import { parseSelectionSection, loadRequestConfig, isRealModelId, isVariantModelId, mergeRequestOptions, RESERVED_PAYLOAD_KEYS } from "../src/selection-config.js";
import { scoreProviders } from "../src/scoring.js";
import { stripReasoningSignatures, isThoughtSignatureError, planSignatureRetry } from "../src/recovery.js";
import { isReasoningModel, parseCost, supportsImages, toRegisteredModel } from "../src/catalog.js";
import type { StatEndpoint, SelectionTuning, OpenRouterModel } from "../src/types.js";

// ---- tier ----

test("tier: router plugin id matches only router slugs", () => {
  assert.equal(routerPluginId("openrouter/auto"), "auto-router");
  assert.equal(routerPluginId("openrouter/auto:nitro"), "auto-router");
  assert.equal(routerPluginId("openrouter/auto-beta"), "auto-beta-router");
  assert.equal(routerPluginId("openrouter/auto-beta:foo"), "auto-beta-router");
  assert.equal(routerPluginId("anthropic/claude-sonnet-4"), undefined);
});

test("tier: parse args", () => {
  assert.deepEqual(parseTierArg("max"), { kind: "tier", tier: "max" });
  assert.deepEqual(parseTierArg("off"), { kind: "clear" });
  assert.deepEqual(parseTierArg("clear"), { kind: "clear" });
  assert.deepEqual(parseTierArg("bogus"), { kind: "invalid", input: "bogus" });
  assert.equal(parseTierArg(undefined), undefined);
  assert.equal(parseTierArg(""), undefined);
});

test("tier: picker marks current", () => {
  const options = tierPickerOptions("low");
  assert.equal(options.length, COST_TIERS.length + 1);
  assert.ok(options.find((o) => o.tier === "low")!.label.includes("(current)"));
});

// ---- selection config ----

test("config: selection parsing overrides per field and drops junk", () => {
  const warnings: string[] = [];
  const tuning = parseSelectionSection(
    { enabled: true, priceAnchor: 1.5, weights: { budget: { throughput: 50, latency: 50, toolCall: 0, price: 0 }, flagship: { throughput: 0, latency: 0, toolCall: 0, price: 100 }, junk: 1 } },
    warnings,
  );
  assert.equal(tuning.priceAnchor, 1.5);
  assert.deepEqual(tuning.budgetWeights, { throughput: 50, latency: 50, toolCall: 0, price: 0 });
  assert.deepEqual(tuning.flagshipWeights, { throughput: 0, latency: 0, toolCall: 0, price: 100 });
  assert.ok(warnings.some((w) => w.includes("junk")));
});

test("config: all-zero weights fall back to defaults", () => {
  const warnings: string[] = [];
  const tuning = parseSelectionSection({ weights: { budget: { throughput: 0, latency: 0, toolCall: 0, price: 0 } } }, warnings);
  assert.ok(warnings.some((w) => w.includes("disables every axis")));
  assert.deepEqual(tuning.budgetWeights, { throughput: 0.55, latency: 0.2, toolCall: 0.15, price: 0.1 });
});

test("config: model id classification", () => {
  assert.ok(!isRealModelId("openrouter/auto"));
  assert.ok(!isRealModelId("~z-ai/glm-flash-latest"));
  assert.ok(!isRealModelId("z-ai/glm-5.3:batch"));
  assert.ok(isRealModelId("z-ai/glm-5.3"));
  assert.ok(isVariantModelId("z-ai/glm-5.3:nitro"));
});

test("config: merge overlays provider and skips reserved keys", () => {
  const options: Record<string, unknown> = {};
  mergeRequestOptions(options, { provider: { data_collection: "deny" }, context_window: 1, stream: true, temperature: 0.2 });
  assert.deepEqual(options.provider, { data_collection: "deny" });
  assert.equal(options.temperature, 0.2);
  assert.equal(options.stream, undefined);
  assert.equal(options.context_window, undefined);
  assert.ok(RESERVED_PAYLOAD_KEYS.has("stream"));
});

test("config: loadRequestConfig validates provider sub-keys", () => {
  const tmp = "/tmp/openrouter-provider-test-config.json";
  fs.writeFileSync(
    tmp,
    JSON.stringify({ requests: { defaults: { provider: { data_collection: "deny", bogus_key: 1 } } } }),
  );
  const { config, warnings } = loadRequestConfig(undefined, tmp, "/nonexistent/openrouter-provider.json");
  assert.ok(warnings.some((w) => w.includes("bogus_key")));
  assert.deepEqual(config.defaults?.provider, { data_collection: "deny" });
});

// ---- scoring ----

const tuning: SelectionTuning = {
  enabled: true,
  priceAnchor: 3.0,
  budgetWeights: { throughput: 0.55, latency: 0.2, toolCall: 0.15, price: 0.1 },
  flagshipWeights: { throughput: 0.3, latency: 0.25, toolCall: 0.2, price: 0.25 },
};

function row(overrides: Partial<StatEndpoint>): StatEndpoint {
  return {
    id: "uuid",
    provider_slug: "provider/main",
    status: 0,
    supported_parameters: ["tools"],
    quantization: "bf16",
    stats: null,
    ...overrides,
  };
}

test("scoring: gates drop disabled/private/tier endpoints", () => {
  const result = scoreProviders(
    "test/model",
    [
      row({ provider_slug: "down/main", status: 1 }),
      row({ provider_slug: "private/main", is_private: true }),
      row({ provider_slug: "provider/flex" }),
      row({ provider_slug: "ok/main", stats: { request_count: 500, p50_throughput: 100, p50_latency: 0.5 } as never }),
    ],
    new Map(),
    tuning,
  );
  assert.ok(result);
  assert.equal(result.pick, "ok/main");
});

test("scoring: stunted-context providers land in ignore", () => {
  const result = scoreProviders(
    "test/model",
    [
      row({ provider_slug: "big/main", context_length: 1000000, stats: { request_count: 500, p50_throughput: 100, p50_latency: 0.5 } as never }),
      row({ provider_slug: "small/main", context_length: 8192, stats: { request_count: 500, p50_throughput: 100, p50_latency: 0.5 } as never }),
    ],
    new Map(),
    tuning,
  );
  assert.ok(result);
  assert.equal(result.pick, "big/main");
  assert.deepEqual(result.ignore, ["small"]);
});

test("scoring: flagship tier weights apply above the price anchor", () => {
  // blended price (3*p+c)/4 = (3*2+8)/4 = 3.5 $/tok => *1e6 >> anchor 3.0 => flagship
  const result = scoreProviders(
    "test/model",
    [
      row({ provider_slug: "a/main", pricing: { prompt: "2", completion: "8" }, stats: { request_count: 500, p50_throughput: 100, p50_latency: 0.5, p99_throughput: 110, p99_latency: 0.6 } as never }),
      row({ provider_slug: "b/main", pricing: { prompt: "2", completion: "8" }, stats: { request_count: 500, p50_throughput: 120, p50_latency: 0.4, p99_throughput: 130, p99_latency: 0.5 } as never }),
    ],
    new Map(),
    tuning,
  );
  assert.ok(result);
  // flagship weights: price dominates but both are priced equally, so throughput wins the tiebreak
  assert.equal(result.pick, "b/main");
});

// ---- recovery ----

test("recovery: detection and single retry", () => {
  assert.ok(isThoughtSignatureError("400: Invalid thought signature"));
  assert.ok(isThoughtSignatureError("Thought signature is not valid for this model"));
  assert.ok(!isThoughtSignatureError("rate limited"));
  const state = { signatureRetried: false };
  assert.ok(planSignatureRetry("Invalid thought signature", state));
  assert.ok(!planSignatureRetry("Invalid thought signature", state));
});

test("recovery: strip removes only signature properties", () => {
  const messages = [
    {
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking...", signature: "encrypted-blob" },
        { type: "text", text: "answer" },
      ],
    },
  ];
  const out = stripReasoningSignatures(messages) as typeof messages;
  assert.notEqual(out, messages);
  assert.equal((out[0].parts[0] as Record<string, unknown>).signature, undefined);
  assert.equal((out[0].parts[0] as Record<string, unknown>).text, "thinking...");
});

// ---- catalog ----

test("catalog: pricing and modalities", () => {
  assert.equal(parseCost("0.000001"), 1);
  assert.equal(parseCost("-1"), undefined);
  assert.equal(parseCost(undefined), undefined);
  assert.ok(supportsImages({ modality: "multimodal" }));
  assert.ok(supportsImages({ input_modalities: ["text", "image"] }));
  assert.ok(!supportsImages({ modality: "text->text" }));
  const m: OpenRouterModel = {
    id: "z-ai/glm-5.3",
    name: "GLM 5.3",
    context_length: 200000,
    top_provider: { max_completion_tokens: 65536 },
    pricing: { prompt: "0.0002", completion: "0.0009", input_cache_read: "0.00002" },
    supported_parameters: ["tools", "reasoning"],
    architecture: { input_modalities: ["text"] },
  };
  assert.ok(isReasoningModel(m));
  const reg = toRegisteredModel(m);
  assert.equal(reg.contextWindow, 200000);
  assert.equal(reg.maxTokens, 65536);
  assert.equal(reg.cost.input, 200);
  assert.equal(reg.reasoning, true);
  assert.deepEqual(reg.input, ["text"]);
});
