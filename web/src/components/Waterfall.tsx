import type { Attempt } from "../lib/api";
import { duration, toolLabel } from "../lib/format";
import { cx, type Tone } from "../ui/primitives";

const statusTone: Record<Attempt["status"], Tone> = { ok: "ok", error: "err", canceled: "neutral", cached: "info", skipped: "warn" };
const statusLabel: Record<Attempt["status"], string> = { ok: "成功", error: "失败", canceled: "已取消", cached: "缓存命中", skipped: "已熔断，跳过" };
const bar: Record<Attempt["status"], string> = { ok: "bg-ok", error: "bg-err", canceled: "bg-ink-3", cached: "bg-info", skipped: "bg-warn" };
const text: Record<Tone, string> = { ok: "text-ok", err: "text-err", neutral: "text-ink-3", info: "text-info", warn: "text-warn", signal: "text-signal-text" };

/**
 * Draws the upstream calls of one request on a shared time axis, so fallback
 * order, races and where the time went can be read at a glance.
 */
export function Waterfall({ attempts, total }: { attempts: Attempt[]; total: number }) {
  const span = Math.max(total, ...attempts.map((a) => a.start_ms + a.duration_ms), 1);
  return (
    <div className="rounded-ctl border border-line">
      <div className="tag flex justify-between border-b border-line px-3 py-1.5">
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
                <span className="num font-medium text-ink">{a.provider}</span>
                {a.target && <span className="truncate text-ink-3">{a.target}</span>}
              </span>
              <span className={cx("num shrink-0", text[statusTone[a.status]])}>
                {statusLabel[a.status]}
                {a.http_status ? ` ${a.http_status}` : ""}
                {a.status !== "cached" && a.status !== "skipped" && ` · ${duration(a.duration_ms)}`}
              </span>
            </div>
            <div className="relative mt-1.5 h-1.5 rounded-full bg-sunken">
              <span
                className={cx("absolute inset-y-0 min-w-1 rounded-full", bar[a.status], a.status === "canceled" && "opacity-50")}
                style={{ left: `${(a.start_ms / span) * 100}%`, width: `${(a.duration_ms / span) * 100}%` }}
              />
            </div>
            {a.error && a.status === "error" && <div className="num mt-1.5 text-xs break-words text-err">{a.error}</div>}
            {a.error && a.status === "skipped" && <div className="num mt-1.5 text-xs break-words text-ink-3">{a.error}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
