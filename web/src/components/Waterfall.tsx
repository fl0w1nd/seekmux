import type { Attempt } from "../lib/api";
import { duration, toolLabel } from "../lib/format";
import { cx, type Tone } from "../ui/primitives";
import { ProviderName } from "./ProviderName";

const statusTone: Record<Attempt["status"], Tone> = { ok: "ok", error: "err", canceled: "neutral", cached: "info", skipped: "warn", limited: "warn" };
const statusLabel: Record<Attempt["status"], string> = { ok: "成功", error: "失败", canceled: "已取消", cached: "缓存命中", skipped: "熔断跳过", limited: "限流跳过" };
const bar: Record<Attempt["status"], string> = { ok: "bg-ok", error: "bg-err", canceled: "bg-ink-3", cached: "bg-info", skipped: "bg-warn", limited: "bg-warn" };
/** Notes about a provider that was not called: they have no duration. */
const note = (status: Attempt["status"]) => status === "cached" || status === "skipped" || status === "limited";
/** Why a provider was passed over; the gateway words the rate limit in English. */
function reason(a: Attempt): string | undefined {
  const slot = a.status === "limited" ? a.error?.match(/next slot in (\S+)$/) : null;
  return slot ? `已达速率限制，配额将在 ${slot[1]} 后恢复` : a.error;
}
const text: Record<Tone, string> = { ok: "text-ok", err: "text-err", neutral: "text-ink-3", info: "text-info", warn: "text-warn", signal: "text-signal-text" };

/**
 * Draws the upstream calls of one request on a shared time axis, so fallback
 * order, races and where the time went can be read at a glance.
 */
export function Waterfall({ attempts, total }: { attempts: Attempt[]; total: number }) {
  const span = Math.max(total, ...attempts.map((a) => a.start_ms + a.duration_ms), 1);
  return (
    <div className="rounded-ctl border border-line">
      <div className="tag flex justify-between border-b border-line px-3 py-1.5 normal-case">
        <span>0</span>
        <span>{duration(span / 2)}</span>
        <span>{duration(span)}</span>
      </div>
      <ol>
        {attempts.map((a, i) => (
          <li key={i} className="border-b border-line px-3 py-2 last:border-b-0">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span className="tag">{toolLabel[a.kind] ?? a.kind}</span>
                <ProviderName id={a.provider} kind={a.kind} className="font-medium text-ink" />
                {a.target && <span className="truncate text-ink-3">{a.target}</span>}
              </span>
              <span className={cx("num shrink-0", text[statusTone[a.status]])}>
                {statusLabel[a.status]}
                {a.http_status ? ` ${a.http_status}` : ""}
                {!note(a.status) && ` · ${duration(a.duration_ms)}`}
              </span>
            </div>
            <div className="relative mt-1.5 h-1.5 rounded-full bg-sunken">
              <span
                className={cx("absolute inset-y-0 min-w-1 origin-left animate-grow-x rounded-full", bar[a.status], a.status === "canceled" && "opacity-50")}
                // Each bar starts drawing when its call started, so the order of the calls plays out once.
                style={{ left: `${(a.start_ms / span) * 100}%`, width: `${(a.duration_ms / span) * 100}%`, animationDelay: `${Math.round((a.start_ms / span) * 360)}ms` }}
              />
            </div>
            {a.error && a.status === "error" && <div className="num mt-1.5 text-xs break-words text-err">{a.error}</div>}
            {a.error && (a.status === "skipped" || a.status === "limited") && <div className="num mt-1.5 text-xs break-words text-ink-3">{reason(a)}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
