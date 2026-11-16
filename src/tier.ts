/**
 * Cost-tier selector helpers for the OpenRouter auto-router plugins.
 *
 * The OpenRouter auto-router accepts a named cost_tier that selects a
 * cost-percentile band of average generation cost for the classified task
 * (low [0,20), medium [20,40), high [40,60), xhigh [60,80), max [80,100]).
 * The tier applies only to the router slugs (openrouter/auto, openrouter/
 * auto-beta); on concrete models it is inert. When no tier is set the
 * extension adds nothing to the payload and the workspace default applies —
 * including when workspace-level "prevent overrides" discards request-level
 * settings (the value is ignored, not an error).
 *
 * The plugin id must match the request's router slug: "auto-router" for
 * openrouter/auto and "auto-beta-router" for openrouter/auto-beta. A
 * mismatched id is silently ignored by the API.
 */

export const COST_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;

export type CostTier = (typeof COST_TIERS)[number];

/** Average-generation-cost percentile band each named tier selects. */
export const COST_TIER_BANDS: Record<CostTier, string> = {
  low: "0-20%",
  medium: "20-40%",
  high: "40-60%",
  xhigh: "60-80%",
  max: "80-100%",
};

const ROUTER_PLUGIN_IDS = ["auto-router", "auto-beta-router"] as const;

/** Plugin id for a router slug: "auto-router" for openrouter/auto (with an
 * optional routing suffix), "auto-beta-router" for openrouter/auto-beta,
 * undefined for anything else. */
export function routerPluginId(model: string): (typeof ROUTER_PLUGIN_IDS)[number] | undefined {
  if (/^openrouter\/auto-beta(:[a-z0-9._-]+)?$/i.test(model)) return "auto-beta-router";
  if (/^openrouter\/auto(:[a-z0-9._-]+)?$/i.test(model)) return "auto-router";
  return undefined;
}

export type ParsedTierArg =
  | { kind: "tier"; tier: CostTier }
  | { kind: "clear" }
  | { kind: "invalid"; input: string };

/**
 * Parse a /openrouter-tier argument. Undefined/empty means "no argument" —
 * the command should open the interactive picker instead. "off" and its
 * aliases clear back to the workspace default.
 */
export function parseTierArg(arg: string | undefined): ParsedTierArg | undefined {
  if (arg === undefined || arg === "") return undefined;
  if ((COST_TIERS as readonly string[]).includes(arg)) {
    return { kind: "tier", tier: arg as CostTier };
  }
  if (["off", "default", "reset", "clear"].includes(arg)) return { kind: "clear" };
  return { kind: "invalid", input: arg };
}

/**
 * Option list for the /openrouter-tier picker: "default" plus the five named
 * tiers, each annotated with its cost-percentile band, the current selection
 * marked. Pure so the labels stay testable.
 */
export function tierPickerOptions(current: CostTier | null): Array<{ label: string; tier: CostTier | null }> {
  const entries: Array<{ label: string; tier: CostTier | null }> = [
    { label: "default — workspace setting", tier: null },
    ...COST_TIERS.map((tier) => ({
      label: `${tier} — cost band ${COST_TIER_BANDS[tier]}`,
      tier: tier as CostTier,
    })),
  ];
  return entries.map((entry) =>
    entry.tier === current ? { ...entry, label: `${entry.label} (current)` } : entry,
  );
}
