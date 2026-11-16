import { Rpc } from "@opencode/plugin/rpc";

export interface ProviderStatus {
  lastSync?: number;
  modelCount: number;
  enabled: boolean;
  priceAnchor: number;
  budgetWeights: Record<string, number>;
  flagshipWeights: Record<string, number>;
  picks: Array<{ model: string; provider: string; at: number }>;
  warnings: string[];
}

export const OpenRouterProviderRpc = Rpc.define({
  id: "openrouter-advanced-provider",
  methods: {
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    sync: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    balance: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    setTier: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, tier: { type: ["string", "null"] } },
        required: ["sessionID", "tier"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
    getTier: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {
    synced: {
      schema: {
        type: "object",
        properties: { modelCount: { type: "number" }, warnings: { type: "array", items: { type: "string" } } },
        required: ["modelCount"],
        additionalProperties: false,
      },
    },
  },
});
