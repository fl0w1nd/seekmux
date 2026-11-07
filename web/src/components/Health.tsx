import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Health } from "../lib/api";
import { Badge, Button } from "../ui/primitives";

/** The limits and health of every provider and model, refreshed while a page shows them. */
export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 5000 }).data;
}

const reasonLabel = { provider: "已熔断", auth: "密钥被拒", quota: "额度用尽" } as const;

function remaining(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  if (seconds < 48 * 3600) return `${Math.ceil(seconds / 3600)} 小时`;
  return `${Math.ceil(seconds / 86400)} 天`;
}

/** Says in a few words why something is switched off and when it comes back. */
export function healthLabel(health: Health): string {
  const reason = reasonLabel[health.disabled_reason ?? "provider"];
  if (health.disabled_ms > 0) return `${reason} · ${remaining(health.disabled_ms)}后${health.disabled_reason === "quota" ? "重置" : "重试"}`;
  return `${reason} · 已停用`;
}

export function HealthBadge({ health }: { health: Health }) {
  return (
    <Badge tone={health.disabled_reason === "auth" || health.disabled_reason === "quota" ? "err" : "warn"} dot>
      {healthLabel(health)}
    </Badge>
  );
}

/** Switches a provider or model the breaker disabled back on. */
export function Reenable({ id, label = "重新启用" }: { id: string; label?: string }) {
  const client = useQueryClient();
  return (
    <Button
      size="sm"
      onClick={async () => {
        await api.resetBreaker(id);
        await Promise.all([client.invalidateQueries({ queryKey: ["status"] }), client.invalidateQueries({ queryKey: ["overview"] })]);
      }}
    >
      {label}
    </Button>
  );
}

/** Shown in place of the quota while the circuit breaker has something switched off. */
export function Tripped({ id, health }: { id: string; health: Health }) {
  return (
    <>
      <HealthBadge health={health} />
      <Reenable id={id} />
    </>
  );
}
