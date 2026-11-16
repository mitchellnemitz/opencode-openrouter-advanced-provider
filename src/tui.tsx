import { Plugin } from "@opencode/plugin/tui";
import { OpenRouterProviderRpc } from "./rpc.js";
import type { ProviderStatus } from "./rpc.js";

interface RpcFacade {
  status(input: Record<string, never>): Promise<ProviderStatus>;
  sync(input: Record<string, never>): Promise<{ modelCount: number; warnings: string[] }>;
  balance(input: Record<string, never>): Promise<{ error: string } | { total_credits?: number; total_usage?: number }>;
  setTier(input: { sessionID: string; tier: string | null }): Promise<{ error: string } | { tier: string | null }>;
  getTier(input: { sessionID: string }): Promise<{ tier: string | null }>;
  events: {
    on(name: "synced", handler: (event: { data: { modelCount: number; warnings?: string[] } }) => void): () => void;
  };
}

function currentSessionID(context: Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]): string | undefined {
  const route = context.ui.router.current();
  if ("params" in route && route.params && typeof route.params === "object" && "sessionID" in route.params) {
    const id = (route.params as { sessionID?: unknown }).sessionID;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

/** TUI part: slash commands that call the server part's RPC and toast results. */
export default Plugin.define({
  id: "openrouter.provider.advanced.cli",
  setup(context) {
    const rpc = context.client.rpc(OpenRouterProviderRpc) as unknown as RpcFacade;

    // Keep the synced-event subscription alive to demo event flow (no-op handler
    // beyond logging warnings).
    const offSynced = rpc.events.on("synced", ({ data }) => {
      if (data.warnings && data.warnings.length > 0) {
        console.warn("[openrouter-provider] config warnings:", data.warnings);
      }
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "openrouter.sync",
          title: "OpenRouter: sync catalog",
          slash: { name: "openrouter-sync" },
          run: async () => {
            try {
              const result = await rpc.sync({});
              context.ui.toast.show({
                title: "OpenRouter",
                message: `Synced ${result.modelCount} models`,
                variant: "success",
              });
            } catch (err) {
              context.ui.toast.show({ title: "OpenRouter", message: `Sync failed: ${String(err)}`, variant: "error" });
            }
          },
        },
        {
          id: "openrouter.balance",
          title: "OpenRouter: show balance",
          slash: { name: "openrouter-balance" },
          run: async () => {
            try {
              const credits = await rpc.balance({});
              const text =
                "error" in credits
                  ? String(credits.error)
                  : `Spent $${(credits.total_usage ?? 0).toFixed(2)} of $${(credits.total_credits ?? 0).toFixed(2)}`;
              context.ui.toast.show({ title: "OpenRouter balance", message: text, duration: 6000 });
            } catch (err) {
              context.ui.toast.show({ title: "OpenRouter", message: String(err), variant: "error" });
            }
          },
        },
        {
          id: "openrouter.status",
          title: "OpenRouter: status",
          slash: { name: "openrouter-status" },
          run: async () => {
            try {
              const status = await rpc.status({});
              const picks = status.picks.length > 0 ? ` · ${status.picks.length} pinned` : "";
              const warns = status.warnings.length > 0 ? ` · ${status.warnings.length} config warning(s)` : "";
              context.ui.toast.show({
                title: "OpenRouter",
                message: `${status.modelCount} models${picks}${warns} · selection ${status.enabled ? "on" : "off"}`,
                duration: 6000,
              });
            } catch (err) {
              context.ui.toast.show({ title: "OpenRouter", message: String(err), variant: "error" });
            }
          },
        },
        {
          id: "openrouter.tier",
          title: "OpenRouter: set auto-router cost tier",
          slash: { name: "openrouter-tier", arguments: true },
          run: async (input) => {
            try {
              const arg = (input ?? "").trim();
              if (!arg || arg === "help") {
                const sessionID = currentSessionID(context) ?? "";
                const current = sessionID ? await rpc.getTier({ sessionID }) : { tier: null };
                const picked = await context.ui.dialog.select({
                  title: "Auto-router cost tier",
                  current: current.tier ?? undefined,
                  options: [
                    { title: "default — workspace setting", value: "off" },
                    { title: "low — cost band 0-20%", value: "low" },
                    { title: "medium — cost band 20-40%", value: "medium" },
                    { title: "high — cost band 40-60%", value: "high" },
                    { title: "xhigh — cost band 60-80%", value: "xhigh" },
                    { title: "max — cost band 80-100%", value: "max" },
                  ],
                });
                if (picked === undefined) return;
                if (sessionID) await rpc.setTier({ sessionID, tier: picked });
                context.ui.toast.show({ title: "OpenRouter", message: `Cost tier: ${picked}`, variant: "success" });
                return;
              }
              const sessionID = currentSessionID(context) ?? "";
              if (!sessionID) {
                context.ui.toast.show({ title: "OpenRouter", message: "No active session", variant: "error" });
                return;
              }
              const result = await rpc.setTier({ sessionID, tier: arg });
              if ("error" in result) {
                context.ui.toast.show({ title: "OpenRouter", message: String(result.error), variant: "error" });
              } else {
                context.ui.toast.show({ title: "OpenRouter", message: `Cost tier: ${result.tier ?? "off"}`, variant: "success" });
              }
            } catch (err) {
              context.ui.toast.show({ title: "OpenRouter", message: String(err), variant: "error" });
            }
          },
        },
      ],
    }));

    return () => offSynced();
  },
});
