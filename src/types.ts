// ---------------------------------------------------------------------------
// OpenRouter wire types
//
// Declared against the live OpenRouter API (openrouter.ai/api/v1) and the
// current API reference. All fields are optional unless the endpoint always
// sends them: OpenRouter adds provider-specific members over time, so
// consumers must tolerate absent fields rather than assume a closed shape.
// ---------------------------------------------------------------------------

/** USD pricing strings per token; "-1" means "varies" (router slugs). */
export interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  internal_reasoning?: string;
  web_search?: string;
  discount?: number;
}

export interface OpenRouterArchitecture {
  modality?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  tokenizer?: string;
}

/** One entry of GET /models and GET /models/user. */
export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  /** Stable slug of the concrete model version, e.g. "z-ai/glm-5.3-20260816". */
  canonical_slug?: string;
  context_length?: number;
  created?: number;
  knowledge_cutoff?: string;
  expiration_date?: string;
  hugging_face_id?: string | null;
  supported_voices?: string[];
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  pricing?: OpenRouterPricing;
  architecture?: OpenRouterArchitecture;
  supported_parameters?: string[];
  default_parameters?: Record<string, unknown> | null;
  per_request_limits?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** Latency/throughput percentiles over a trailing window. */
export interface PercentileStats {
  p50: number;
  p75: number;
  p90: number;
  p99: number;
}

/** One serving provider for a model, from GET /models/{author}/{slug}/endpoints. */
export interface OpenRouterEndpoint {
  name?: string;
  provider_name?: string;
  tag?: string;
  quantization?: string;
  context_length?: number;
  max_completion_tokens?: number;
  max_prompt_tokens?: number;
  pricing?: OpenRouterPricing;
  supported_parameters?: string[];
  status?: number;
  uptime_last_5m?: number;
  uptime_last_30m?: number;
  uptime_last_1d?: number;
  latency_last_30m?: PercentileStats | null;
  throughput_last_30m?: PercentileStats | null;
  supports_implicit_caching?: boolean;
  supports_tool_choice?: boolean;
}

export interface OpenRouterEndpointsResponse {
  data?: {
    id?: string;
    name?: string;
    endpoints?: OpenRouterEndpoint[];
  };
}

/** GET /credits: account-level balance. */
export interface OpenRouterCreditsInfo {
  total_credits?: number;
  total_usage?: number;
}

// ---------------------------------------------------------------------------
// Per-request routing config (user config file / plugin options)
// ---------------------------------------------------------------------------

/**
 * Extra request configuration for one model, merged into the outgoing
 * request. `provider` mirrors OpenRouter's per-request routing object —
 * strictly validated upstream (unknown keys 400), so the loader rejects
 * unknown sub-keys at load. Every other key passes through as a top-level
 * request field; keys OpenCode owns are rejected at load time.
 *
 * `context_window` / `max_completion_tokens` never reach the wire: they
 * override the registered model's derived limits.
 */
export interface ModelRequestConfig {
  provider?: Record<string, unknown>;
  context_window?: number;
  max_completion_tokens?: number;
  [field: string]: unknown;
}

export interface RequestConfig {
  /** Applied to every request; per-model entries and the JIT pick merge on top. */
  defaults?: ModelRequestConfig;
  models?: Map<string, ModelRequestConfig>;
}

export interface LoadedRequestConfig {
  config: RequestConfig;
  selection: SelectionTuning;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Provider-selection tuning (user config file / plugin options)
// ---------------------------------------------------------------------------

/** Relative axis weights; only ratios matter, zero disables the axis. */
export interface SelectionWeights {
  throughput: number;
  latency: number;
  toolCall: number;
  price: number;
}

/** Tuning for the just-in-time provider selection algorithm. */
export interface SelectionTuning {
  /** false: no client-side pick and no stats fetches — OpenRouter default routing. */
  enabled: boolean;
  /** Blended $/M splitting budget weights from flagship weights. */
  priceAnchor: number;
  budgetWeights: SelectionWeights;
  flagshipWeights: SelectionWeights;
}

// ---------------------------------------------------------------------------
// OpenCode model-registration shape (subset used by this plugin)
// ---------------------------------------------------------------------------

export interface RegisteredModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  releaseDate?: string;
}

export interface SyncSnapshot {
  generation: number;
  models: RegisteredModel[];
  timestamp: number;
}

export interface EndpointCacheEntry {
  timestamp: number;
  endpoints: OpenRouterEndpoint[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const PROVIDER_ID = "openrouter";
export const CACHE_TTL_MS = 30 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Just-in-time provider selection (frontend stats surface)
// ---------------------------------------------------------------------------

/**
 * One endpoint row of the frontend per-model stats response. This is an
 * OpenRouter website API, not a documented public one: verify against live
 * responses when it misbehaves. Row shape verified 2026-09.
 */
export interface StatEndpoint {
  id: string;
  provider_slug: string;
  provider_name?: string;
  provider_display_name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  quantization?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    discount?: number;
  };
  supported_parameters?: string[];
  status?: number;
  is_disabled?: boolean;
  is_private?: boolean;
  is_free?: boolean;
  is_byok?: boolean;
  is_deranked?: boolean;
  /** 30-minute latency/throughput percentiles for this endpoint. */
  stats: {
    p50_latency?: number;
    p75_latency?: number;
    p90_latency?: number;
    p95_latency?: number;
    p99_latency?: number;
    p50_throughput?: number;
    p99_throughput?: number;
    request_count?: number;
    latency_request_count?: number;
    throughput_request_count?: number;
    window_minutes?: number;
  } | null;
}

/** The just-in-time selection outcome for one model. */
export interface SelectionResult {
  /** Winning provider slug (region-qualified where the winner is regional). */
  pick: string;
  /** The winning row's quantization; requests pin it so OpenRouter cannot
   *  serve a different variant of the same provider than the one scored. */
  quantization?: string;
  /** Stunted-context providers, excluded from fallbacks via request ignore. */
  ignore: string[];
  /** The winner's context window — becomes the model's registered window. */
  contextLength: number;
  maxCompletionTokens?: number;
  /** Surfaced when a compliant alternative is much faster right now. */
  advisory?: string;
  /** Score table (sorted best first) for status reporting. */
  table: ScoredProvider[];
  sampledCount: number;
}

export interface ScoredProvider {
  tag: string;
  contextLength?: number;
  quantization: string;
  /** USD per token, blended. Undefined when the endpoint has no finite
   *  pricing — unknown is never displayed or sorted as free. */
  blendedPrice?: number;
  tpsP50?: number;
  latP50?: number;
  tailRatio?: number;
  toolCallErrorRate?: number;
  score?: number;
}
