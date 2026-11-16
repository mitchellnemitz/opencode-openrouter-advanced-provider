# opencode-openrouter-advanced-provider

An [OpenRouter](https://openrouter.ai) provider plugin for [OpenCode 2.x](https://opencode.ai):
account-scoped live model catalog, real context windows, just-in-time weighted provider
selection, and session cost tiers for the auto-routers. Port of
`pi-openrouter-advanced-provider`.

## What it does

- **Live account catalog.** Syncs OpenRouter's `/models/user` endpoint (the models your key
  can actually use, including BYOK models and `~` latest-aliases; the public `/models` list
  otherwise) into OpenCode's provider registry. Catalog ids with `:batch`/`:nitro`/`:floor`
  routing-variant suffixes are not registered; `:free` — a price indicator, not a tier —
  remains selectable. The picker is filtered to the agentic-usable capability set
  (tools + reasoning); routing constructs (`openrouter/auto`, `~` aliases) survive the filter.
- **Real context windows.** A model's registered context window comes from the serving
  provider's endpoint data, not the catalog maximum, so OpenCode budgets and compacts against
  what the route actually offers.
- **Just-in-time provider selection.** At each request to an OpenRouter model, the plugin
  fetches the model's per-endpoint stats (30-minute rolling window) and computes a weighted
  composite score, then pins the winner via the request's `provider` routing object:
  `{ order: [pick], ignore: [...stunted providers], allow_fallbacks: true }`. The pick is
  cached for 10 minutes; a stale pick keeps serving while a refresh is in flight.
- **Session cost tiers.** `/openrouter-tier low|medium|high|xhigh|max|off` sets a
  session-scoped `cost_tier` that is attached to the wire only when the request targets a
  router slug (`openrouter/auto` → `auto-router`, `openrouter/auto-beta` → `auto-beta-router`).
  No selection sends nothing, so the workspace routing settings apply untouched.
- **Thought-signature failover recovery.** When OpenRouter fails over between a model's
  backing providers, replayed encrypted reasoning signatures are rejected with a 400. The
  plugin detects the error, strips signature fields from the replayed reasoning parts, and
  forces one immediate retry.
- **Clean info channel.** `/openrouter-sync`, `/openrouter-balance`, `/openrouter-status`
  report through toasts (TUI) and the RPC surface — nothing is injected into model context.

## Selection scoring

Gates (in order): disabled/private endpoints, service tiers (flex/fast/priority/highspeed),
no-`tools` endpoints, heavy quantization (4-bit) when any candidate serves a lighter one, and
stunted context — endpoints below 50% of the median `context_length` are excluded AND added
to the request's `ignore` list so fallbacks cannot land on them. Endpoints without samples
are fallback-only; a model with no sampled endpoints picks price-first.

Adaptive axes by price anchor (blended $/M, default $3.00):
- **Below the anchor** (budget models): throughput 0.55 (consistency-adjusted `p50 × √(p50/p99)`),
  latency 0.20 (half inverse p50, half inverse tail ratio), tool-call quality 0.15
  (soft floor: ≤3% error rate ≈ full credit), price 0.10.
- **At or above the anchor** (flagships): throughput 0.30, latency 0.25, tool-call 0.20, price 0.25.

Ties within 5% of the top score break in descending weight order — the tier's dominant axis
decides first. A compliant alternative serving ≥1.75× the winner's p50 throughput is
advisory only.

## Install

From npm (once published):

```sh
opencode plugin add opencode-openrouter-advanced-provider
```

Or for development, check the directory out under `.opencode/plugins/opencode-openrouter-advanced-provider/`
(it auto-discovers), or add to `opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-openrouter-advanced-provider"]
}
```

Requires OpenCode 2.2+ (V2 plugin API; V1 plugins do not run on V2).

## API key

One of:

- `OPENROUTER_API_KEY` in the OpenCode server's environment, or
- an OpenRouter account connected in OpenCode (`/connect`).

Without a key no registration happens — falling back to the public catalog would silently
swap account-scoped data for the generic list.

## Configuration

One file name, layered — later layers win per field:

1. `openrouter-advanced-provider.json` shipped in the package (defaults below).
2. `~/.config/opencode/openrouter-advanced-provider.json` — user overrides.
3. Plugin options in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-openrouter-advanced-provider",
      "options": {
        "selection": {
          "enabled": true,
          "priceAnchor": 3.0,
          "weights": {
            "budget": { "throughput": 0.55, "latency": 0.2, "toolCall": 0.15, "price": 0.1 },
            "flagship": { "throughput": 0.3, "latency": 0.25, "toolCall": 0.2, "price": 0.25 }
          }
        },
        "requests": {
          "defaults": { "provider": { "data_collection": "deny" } },
          "models": {
            "z-ai/glm-5.3": {
              "provider": { "order": ["deepinfra", "parasail"], "ignore": ["io-net"], "allow_fallbacks": true },
              "context_window": 1048576
            }
          }
        }
      }
    }
  ]
}
```

- `selection.enabled: false` turns client-side selection off entirely (no picks, no stats
  fetches); `requests` entries keep working.
- `weights` values are ratios — only relative size matters. A zero weight removes the axis
  from scoring and tiebreaks. An all-zero weight set keeps the defaults for that tier.
- `requests.models` entries keyed by exact OpenRouter model id bypass the algorithm:
  the entry's `provider` object merges into every request for that model, other fields pass
  through as top-level request fields, and `context_window` / `max_completion_tokens` are
  plugin-side only (they set the registered limits, never the wire).
- OpenRouter rejects unknown `provider` sub-keys with a 400, so the loader drops unknown
  sub-keys and type-violating values with a warning (surfaced on `/openrouter-status`).
- Only real model ids get entries: router slugs, `~` aliases, and `:batch`/`:nitro`/`:floor`
  ids are skipped with a warning.

Reload via `/openrouter-sync` after editing.

## Commands

- `/openrouter-sync` — refresh the catalog and re-run provider selection.
- `/openrouter-balance` — show your OpenRouter credit balance and usage.
- `/openrouter-status` — show sync state and current selections.
- `/openrouter-tier` — set the session's auto-router cost tier (interactive picker with no
  argument, or `low|medium|high|xhigh|max|off`).

## Development

```sh
npm install
npm run typecheck
npm test
```

## Known gaps vs the pi extension

- OpenCode's session cost accounting is internal; the plugin cannot fold OpenRouter's billed
  cost into OpenCode's own totals.
- OpenCode has no per-response stream metadata surface; the billed-cost capture pi does on
  the stream is out of scope here.
- Verified on OpenCode v2.3.0: catalog registration, the session `context` hook (JIT pick
  recorded), the RPC surface, cost-tier set/get/clear, and hot reload all work for
  **service-executed sessions** (the TUI and anything driving `POST /api/session/:id/prompt`).
  `opencode run` executes sessions in its own runtime and does not fire plugin session
  hooks — headless users should drive the shared service (SDK/`opencode api`) instead.
- The `context` hook's provider options are passed through by OpenCode's protocol layer;
  the `provider` overlay was verified to be applied at the hook level, but a packet-level
  check that `provider.order` reaches the OpenRouter wire (e.g. behind a logging proxy)
  is a reasonable extra belt-and-suspenders step.

## License

MIT
