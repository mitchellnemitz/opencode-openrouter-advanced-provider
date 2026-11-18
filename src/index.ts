import { Plugin, Provider, Model } from "@opencode/plugin";
type Context = Plugin.Context;
import {
  PROVIDER_ID,
  type ModelRequestConfig,
  type OpenRouterCreditsInfo,
  type RegisteredModel,
  type SelectionResult,
} from "./types.js";
import { fetchCredits, fetchPermaslugMap, fetchEndpointStats, fetchToolCallErrorRates } from "./api.js";
import { scoreProviders } from "./scoring.js";
import {
  buildSync,
  clearSelections,
  commitSnapshot,
  getSnapshot,
  getStaleSelection,
  nextGeneration,
  setSelection,
} from "./state.js";
import { loadRequestConfig, mergeRequestOptions } from "./selection-config.js";
import type { LoadedRequestConfig } from "./types.js";
import { COST_TIERS, parseTierArg, routerPluginId, type CostTier } from "./tier.js";
import { planSignatureRetry, stripReasoningSignatures, type RecoveryState } from "./recovery.js";
import { OpenRouterProviderRpc, type ProviderStatus } from "./rpc.js";

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

async function resolveApiKey(ctx: Context): Promise<string | undefined> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (connection) {
      const credential = await ctx.integration.connection.resolve(connection);
      const key =
        credential && typeof credential === "object" ? (credential as { key?: string }).key : undefined;
      if (typeof key === "string" && key) return key;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Just-in-time selection
// ---------------------------------------------------------------------------

interface SelectionRuntime {
  tuning: LoadedRequestConfig["selection"];
  inFlight: Map<string, Promise<SelectionResult | undefined>>;
}

async function ensurePick(rt: SelectionRuntime, modelId: string): Promise<SelectionResult | undefined> {
  if (!rt.tuning.enabled) return undefined;
  if (routerPluginId(modelId)) return undefined; // routers route themselves
  const cached = getStaleSelection(modelId);
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) return cached.result;
  const inFlight = rt.inFlight.get(modelId);
  if (inFlight) return cached?.result ?? (await inFlight.catch(() => undefined));
  const job = (async () => {
    try {
      const permaslugs = await fetchPermaslugMap();
      const permaslug = permaslugs.get(modelId);
      if (!permaslug) return undefined;
      const [endpoints, toolRates] = await Promise.all([
        fetchEndpointStats(permaslug),
        fetchToolCallErrorRates(permaslug),
      ]);
      return scoreProviders(modelId, endpoints, toolRates, rt.tuning);
    } catch {
      return undefined;
    }
  })();
  rt.inFlight.set(modelId, job);
  try {
    const result = await job;
    if (result) setSelection(modelId, result);
    // Serve the last-known pick rather than routing blind while refreshing.
    return cached?.result ?? result;
  } finally {
    rt.inFlight.delete(modelId);
  }
}

// ---------------------------------------------------------------------------
// Session cost tiers (storage-backed, per session)
// ---------------------------------------------------------------------------

const tierKey = (sessionID: string) => `openrouter-advanced-provider:tier:${sessionID}`;

async function getTier(ctx: Context, sessionID: string): Promise<CostTier | null> {
  const value = await ctx.storage.get(tierKey(sessionID));
  return value === null || (typeof value === "string" && (COST_TIERS as readonly string[]).includes(value))
    ? (value as CostTier | null)
    : null;
}

/** Overlay a router cost tier onto the request options as a plugins entry. */
function overlayTier(options: Record<string, unknown>, model: string, tier: CostTier): void {
  const pluginId = routerPluginId(model);
  if (!pluginId) return;
  const entry = { id: pluginId, cost_tier: tier };
  const existing = Array.isArray(options.plugins) ? [...(options.plugins as unknown[])] : [];
  const index = existing.findIndex(
    (p) => p && typeof p === "object" && !Array.isArray(p) && (p as { id?: string }).id === pluginId,
  );
  if (index >= 0) existing[index] = entry;
  else existing.push(entry);
  options.plugins = existing;
}

// ---------------------------------------------------------------------------
// Model registration
// ---------------------------------------------------------------------------

/** Convert one registered model into the OpenCode model-info registration shape. */
export function toModelInfo(m: RegisteredModel): Model.Info {
  const providerID = Provider.ID.make(PROVIDER_ID);
  const base = Model.Info.default(providerID, Model.ID.make(m.id)) as unknown as Record<string, unknown>;
  const info: Record<string, unknown> = {
    ...base,
    name: m.name,
    enabled: true,
    status: "active",
    capabilities: {
      ...(base.capabilities as Record<string, unknown> | undefined),
      tools: true,
      input: m.input,
      output: ["text"],
      temperature: true,
    },
    // One variant per OpenRouter-supported effort; the provider package maps
    // reasoningEffort to the request's reasoning.effort. No variant = the
    // router's default_effort.
    variants: (m.efforts ?? []).map((effort) => ({
      id: effort,
      settings: { reasoningEffort: effort },
    })),
    limit: {
      context: m.contextWindow,
      output: m.maxTokens,
    },
    cost: [
      {
        input: m.cost.input,
        output: m.cost.output,
        cache: { read: m.cost.cacheRead, write: m.cost.cacheWrite },
      },
    ],
    ...(m.releaseDate && Number.isFinite(Date.parse(m.releaseDate))
      ? { time: { released: Date.parse(m.releaseDate) } }
      : {}),
  };
  return info as Model.Info;
}

async function registerModels(ctx: Context, models: RegisteredModel[]): Promise<void> {
  const infos = models.map(toModelInfo);
  await ctx.provider.transform((editor) => {
    const existing = editor.get(PROVIDER_ID);
    if (existing) {
      editor.models.set(PROVIDER_ID, infos);
    } else {
      editor.add({
        info: {
          ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
          name: "OpenRouter",
          activation: "enabled",
          package: "@opencode/ai/providers/openrouter",
        },
        models: infos,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "openrouter.provider.advanced",
  async setup(ctx: Context) {
    const apiKey = await resolveApiKey(ctx);

    // Config: shipped file < user file < plugin options (highest precedence).
    let loaded = loadRequestConfig(ctx.options as Record<string, unknown> | undefined);
    const runtime: SelectionRuntime = { tuning: loaded.selection, inFlight: new Map() };

    // Thought-signature failover recovery, per session: http.response flags
    // the error, context strips signatures from the replay, retry forces the
    // single retry.
    const recoveryStates = new Map<string, RecoveryState & { pendingStrip?: boolean }>();

    // ----- catalog sync -----
    let syncing = false;
    const syncCatalog = async (force = false): Promise<{ modelCount: number; warnings: string[] }> => {
      if (syncing) return { modelCount: getSnapshot().models.length, warnings: [] };
      syncing = true;
      try {
        const generation = nextGeneration();
        const { models } = await buildSync(apiKey, force, loaded.config);
        if (commitSnapshot(generation, models)) {
          await registerModels(ctx, models);
          clearSelections();
        }
        return { modelCount: models.length, warnings: loaded.warnings };
      } finally {
        syncing = false;
      }
    };

    await ctx.provider.transform((editor) => {
      // Keep the provider active while the first sync runs.
      const existing = editor.get(PROVIDER_ID);
      if (existing) {
        editor.update(PROVIDER_ID, (provider) => {
          provider.activation = "enabled";
        });
      }
    });

    try {
      const result = await syncCatalog(true);
      if (result.warnings.length > 0) {
        console.warn("[openrouter-advanced-provider] config warnings:", result.warnings);
      }
    } catch (err) {
      console.warn(
        "[openrouter-advanced-provider] initial catalog sync failed:",
        err instanceof Error ? err.message : err,
      );
    }

    // ----- request overlay: provider routing, config entries, cost tier -----
    await ctx.session.hook("context", async (event) => {
      const modelId = event.model.id;
      const options = event.options as Record<string, unknown>;

      // Config defaults ride every request; per-model entries merge on top.
      if (loaded.config.defaults) mergeRequestOptions(options, loaded.config.defaults);
      const entry: ModelRequestConfig | undefined = loaded.config.models?.get(modelId);
      if (entry) mergeRequestOptions(options, entry);

      // Thought-signature recovery: strip replay signatures on the retry.
      const state = recoveryStates.get(event.sessionID);
      if (state?.pendingStrip) {
        event.messages = stripReasoningSignatures(event.messages) as typeof event.messages;
        state.pendingStrip = false;
      }

      // Just-in-time provider selection.
      const pick = await ensurePick(runtime, modelId);
      if (pick) {
        const base =
          options.provider && typeof options.provider === "object" && !Array.isArray(options.provider)
            ? { ...(options.provider as Record<string, unknown>) }
            : {};
        options.provider = {
          ...base,
          order: [pick.pick],
          ...(pick.ignore.length > 0 ? { ignore: pick.ignore } : {}),
          allow_fallbacks: true,
          ...(pick.quantization ? { quantizations: [pick.quantization] } : {}),
        };
      }

      // Session cost tier for the auto-routers.
      const tier = await getTier(ctx, event.sessionID);
      if (tier) overlayTier(options, modelId, tier);
    }, { providerID: PROVIDER_ID });

    await ctx.session.hook("http.response", async (event) => {
      if (event.response.status !== 400) return;
      let state = recoveryStates.get(event.sessionID);
      if (!state) {
        state = { signatureRetried: false };
        recoveryStates.set(event.sessionID, state);
      }
      let body: string | undefined;
      try {
        body = await event.response.clone().text();
      } catch {
        return;
      }
      if (planSignatureRetry(body, state)) state.pendingStrip = true;
    }, { providerID: PROVIDER_ID });

    await ctx.session.hook("retry", (event) => {
      // One forced immediate retry for rejected requests; the signature strip
      // (flagged by http.response) is what makes the retry succeed.
      if (event.error.type === "provider.invalid-request" && event.attempt <= 2) {
        event.decision = { retry: true, delay: 0 };
      }
    }, { providerID: PROVIDER_ID });

    // ----- commands -----
    await ctx.command.transform((editor) => {
      editor.add({
        name: "openrouter-sync",
        description: "Refresh the OpenRouter catalog and re-run provider selection",
        execute: async () => {
          loaded = loadRequestConfig(ctx.options as Record<string, unknown> | undefined);
          runtime.tuning = loaded.selection;
          const result = await syncCatalog(true);
          await rpcRegistration.events.emit("synced", {
            modelCount: result.modelCount,
            warnings: result.warnings,
          });
        },
      });
      editor.add({
        name: "openrouter-balance",
        description: "Record your OpenRouter credit balance and usage",
        execute: async () => {
          if (!apiKey) return;
          const credits: OpenRouterCreditsInfo | null = await fetchCredits(apiKey);
          if (credits) await ctx.storage.set("openrouter-advanced-provider:balance", { ...credits, at: Date.now() });
        },
      });
      editor.add({
        name: "openrouter-status",
        description: "Record OpenRouter sync state, picks, and active tuning",
        execute: async () => {
          const status = buildStatus(loaded);
          await ctx.storage.set("openrouter-advanced-provider:status", { ...status, at: Date.now() });
        },
      });
      editor.add({
        name: "openrouter-tier",
        description: "Set this session's auto-router cost tier (low|medium|high|xhigh|max|off)",
        execute: async ({ sessionID, prompt }) => {
          const arg = String((prompt as { text?: string } | undefined)?.text ?? "").trim();
          const parsed = arg ? parseTierArg(arg) : undefined;
          if (!arg) {
            const current = await getTier(ctx, sessionID);
            await ctx.storage.set(`openrouter-advanced-provider:tier-help:${sessionID}`, {
              message: `Usage: /openrouter-tier ${COST_TIERS.join("|")}|off${current ? ` (current: ${current})` : ""}`,
            });
            return;
          }
          if (!parsed || parsed.kind === "invalid") {
            await ctx.storage.set(`openrouter-advanced-provider:tier-help:${sessionID}`, {
              message: `Unknown tier "${parsed && parsed.kind === "invalid" ? parsed.input : arg}" — options: ${COST_TIERS.join(", ")}, off`,
            });
            return;
          }
          if (parsed.kind === "clear") await ctx.storage.remove(tierKey(sessionID));
          else await ctx.storage.set(tierKey(sessionID), parsed.tier);
        },
      });
    });

    // ----- RPC (status surface for TUI/desktop clients) -----
    const rpcRegistration = await ctx.rpc.register(OpenRouterProviderRpc, {
      status: async () => buildStatus(loaded),
      sync: async () => {
        loaded = loadRequestConfig(ctx.options as Record<string, unknown> | undefined);
        runtime.tuning = loaded.selection;
        return await syncCatalog(true);
      },
      balance: async () => {
        if (!apiKey) return { error: "no openrouter key" };
        return (await fetchCredits(apiKey)) ?? { error: "no data (management key required)" };
      },
      setTier: async (raw) => {
        const { sessionID, tier } = raw as { sessionID: string; tier: string | null };
        const value = tier === null || tier === "off" ? null : (tier as CostTier);
        if (value !== null && !(COST_TIERS as readonly string[]).includes(value)) {
          return { error: `unknown tier ${String(tier)}` };
        }
        if (value === null) await ctx.storage.remove(tierKey(sessionID));
        else await ctx.storage.set(tierKey(sessionID), value);
        return { tier: value };
      },
      getTier: async (raw) => {
        const { sessionID } = raw as { sessionID: string };
        return { tier: await getTier(ctx, sessionID) };
      },
    });

    function buildStatus(cfg: LoadedRequestConfig): ProviderStatus {
      const snapshot = getSnapshot();
      const picks: ProviderStatus["picks"] = [];
      for (const model of snapshot.models) {
        const cached = getStaleSelection(model.id);
        if (cached) picks.push({ model: model.id, provider: cached.result.pick, at: cached.timestamp });
      }
      return {
        lastSync: snapshot.timestamp || undefined,
        modelCount: snapshot.models.length,
        enabled: cfg.selection.enabled,
        priceAnchor: cfg.selection.priceAnchor,
        budgetWeights: { ...cfg.selection.budgetWeights },
        flagshipWeights: { ...cfg.selection.flagshipWeights },
        picks,
        warnings: cfg.warnings,
      };
    }

    return () => {
      clearSelections();
    };
  },
});
