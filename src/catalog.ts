import type { OpenRouterArchitecture, OpenRouterModel, RegisteredModel } from "./types.js";

// ---------------------------------------------------------------------------
// Reasoning detection
//
// OpenRouter signals reasoning support inconsistently across providers: some
// declare a supported parameter, some ship reasoning defaults, some only
// hint at it in the id or display name. A model counts as a reasoning model
// when any signal fires.
// ---------------------------------------------------------------------------

const REASONING_ID_PATTERNS = [
  ":thinking",
  "-r1",
  "/r1",
  "o1-",
  "o3-",
  "o4-",
  "reasoner",
  "-thinking",
  "qwq-",
  "/qwq",
];

const REASONING_NAME_PATTERNS = ["thinking", "reasoner", "chain-of-thought"];

const REASONING_PARAMETER_NAMES = new Set([
  "include_reasoning",
  "reasoning",
  "reasoning_effort",
]);

function declaresReasoningParameter(supportedParameters?: string[]): boolean {
  return supportedParameters?.some((p) => REASONING_PARAMETER_NAMES.has(p)) ?? false;
}

function shipsReasoningDefaults(defaultParameters?: Record<string, unknown> | null): boolean {
  return (
    defaultParameters?.include_reasoning !== undefined ||
    defaultParameters?.reasoning !== undefined ||
    defaultParameters?.reasoning_effort !== undefined
  );
}

function idOrNameSuggestsReasoning(id: string, name?: string): boolean {
  const lowerId = id.toLowerCase();
  const lowerName = (name || "").toLowerCase();
  return (
    REASONING_ID_PATTERNS.some((pattern) => lowerId.includes(pattern)) ||
    REASONING_NAME_PATTERNS.some((pattern) => lowerName.includes(pattern))
  );
}

export function isReasoningModel(m: OpenRouterModel): boolean {
  return (
    declaresReasoningParameter(m.supported_parameters) ||
    shipsReasoningDefaults(m.default_parameters) ||
    idOrNameSuggestsReasoning(m.id, m.name)
  );
}

// ---------------------------------------------------------------------------
// Input modality
// ---------------------------------------------------------------------------

export function supportsImages(architecture?: OpenRouterArchitecture): boolean {
  if (architecture?.input_modalities) {
    return architecture.input_modalities.includes("image");
  }
  return architecture?.modality?.includes("multimodal") ?? false;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Parse an OpenRouter pricing string into USD per million tokens. Missing is
 * not zero: an absent price stays undefined so callers can distinguish it
 * from free. The "-1" sentinel (router slugs like openrouter/auto, where the
 * price varies with the routed model) is also not a price.
 */
export function parseCost(value?: string): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed === -1) return undefined;
  return parsed * 1_000_000;
}

function costOrFallback(cost: number | undefined, fallback: number): number {
  return cost !== undefined ? cost : fallback;
}

/** Convert one catalog model into the OpenCode registration shape. */
export function toRegisteredModel(m: OpenRouterModel): RegisteredModel {
  return {
    id: m.id,
    name: m.name || m.id,
    reasoning: isReasoningModel(m),
    input: supportsImages(m.architecture) ? ["text", "image"] : ["text"],
    cost: {
      input: costOrFallback(parseCost(m.pricing?.prompt), 0),
      output: costOrFallback(parseCost(m.pricing?.completion), 0),
      cacheRead: costOrFallback(parseCost(m.pricing?.input_cache_read), 0),
      cacheWrite: costOrFallback(parseCost(m.pricing?.input_cache_write), 0),
    },
    contextWindow: m.context_length || 128_000,
    maxTokens: m.top_provider?.max_completion_tokens || 16_384,
    releaseDate: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : undefined,
  };
}
