import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { TraceNode } from "../../lib/api";
import { duration } from "../../lib/format";
import { useNow } from "../../lib/motion";
import { attr } from "../../lib/trace";
import { Button, CodeBlock, cx, Dot } from "../../ui/primitives";
import { ProviderName } from "../ProviderName";
import { candidateReason, candidates, conclusion, factsOf, kindLabel, statusLabel, statusTone, subject, titleOf } from "./wording";

const barColor: Record<TraceNode["status"], string> = {
  running: "bg-signal-text",
  ok: "bg-ok",
  error: "bg-err",
  canceled: "bg-ink-3/60",
  cached: "bg-info",
  skipped: "bg-warn",
  limited: "bg-warn",
};

function Group({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line px-4 py-3">
      {title && <h3 className="tag mb-1.5">{title}</h3>}
      {children}
    </section>
  );
}

function Fact({ label, mono = true, known = true, children }: { label: string; mono?: boolean; known?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5 text-xs">
      <dt className={cx("shrink-0 text-ink-3", !known && "num")}>{label}</dt>
      <dd className={cx("min-w-0 text-right break-words text-ink", mono && "num")}>{children}</dd>
    </div>
  );
}

/** What a model has written so far; it stays at its end while more arrives. */
function Written({ text, live }: { text: string; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (live && el) el.scrollTop = el.scrollHeight;
  }, [text, live]);
  return (
    <pre ref={ref} className="num max-h-64 overflow-auto rounded-ctl border border-line bg-sunken p-3 text-xs leading-5 break-words whitespace-pre-wrap text-ink-2">
      {text}
      {live && <span aria-hidden className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse-dot bg-signal-text" />}
    </pre>
  );
}

export interface NodeDetailProps {
  node: TraceNode;
  /** What the node's model has written, when it is a model's. */
  text?: string;
  /** The call's length in ms, for placing the node on its time axis. */
  total: number;
  /** When the call began, by this browser's clock; set while it runs. */
  origin?: number;
  onClose?: () => void;
  closeClassName?: string;
}

/** Everything the gateway recorded about one node of a flow. */
export function NodeDetail({ node, text, total, origin = 0, onClose, closeClassName }: NodeDetailProps) {
  const running = node.status === "running";
  const live = origin > 0;
  const now = useNow(live, 200);
  const took = running ? Math.max(0, now - origin - node.start_ms) : (node.duration_ms ?? 0);
  const span = Math.max(total, live ? now - origin : 0, node.start_ms + took, 1);
  const { groups, blocks } = factsOf(node);
  const says = conclusion(node);
  const list = node.kind === "route" ? candidates(node) : [];
  const asked = subject(node);
  const args = attr<Record<string, unknown>>(node, "args");
  const note = attr<string>(node, "note");
  const left = Math.min(100, (node.start_ms / span) * 100);
  let order = 0;

  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex items-start gap-3 px-4 pt-3 pb-3">
        <div className="min-w-0 flex-1">
          <div className="tag">{kindLabel[node.kind] ?? node.kind}</div>
          <div className="mt-0.5 flex min-w-0 items-center text-base font-medium">
            {node.kind === "attempt" ? (
              <ProviderName id={node.name ?? ""} icon="size-4" />
            ) : node.kind === "llm" || node.kind === "agent" ? (
              <span className="num min-w-0 truncate">{node.name}</span>
            ) : node.kind === "query" || node.kind === "worker" ? (
              <span className="min-w-0 break-words">{node.name}</span>
            ) : (
              <span className="min-w-0 truncate">{titleOf(node)}</span>
            )}
          </div>
        </div>
        {onClose && <Button variant="ghost" size="sm" icon={<X />} aria-label="关闭" className={cx("-mr-1.5", closeClassName)} onClick={onClose} />}
      </header>

      <div className="px-4 pb-3">
        <div className="flex items-center gap-2 text-sm">
          <Dot tone={statusTone[node.status]} live={running} />
          <span>{statusLabel[node.status]}</span>
          {node.http_status ? <span className="num text-ink-3">HTTP {node.http_status}</span> : null}
          <span className="num ml-auto text-ink-2">{running || node.duration_ms ? duration(took) : "瞬时"}</span>
        </div>
        <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-sunken">
          <span
            className={cx("absolute inset-y-0 min-w-0.5 rounded-full", barColor[node.status])}
            style={{ left: `${left}%`, width: `${Math.min(100 - left, (took / span) * 100)}%` }}
          />
        </div>
        <div className="tag mt-1 flex justify-between normal-case">
          <span>请求开始后 {duration(node.start_ms)}</span>
          <span>全程 {duration(span)}</span>
        </div>
        {says && <p className="mt-2 text-sm text-ink-2">{says}</p>}
      </div>

      {node.error && (
        <Group title={node.status === "error" ? "错误" : "说明"}>
          <div className={cx("num text-xs break-words", node.status === "error" ? "text-err" : "text-ink-2")}>{node.error}</div>
        </Group>
      )}

      {asked && node.kind !== "query" && (
        <Group title="请求的是">
          <div className="num text-xs break-all text-ink">{asked}</div>
        </Group>
      )}

      {note && (
        <Group title="模型的说明">
          <p className="text-xs whitespace-pre-wrap text-ink-2">{note}</p>
        </Group>
      )}

      {list.length > 0 && (
        <Group title={`候选 · ${list.length}`}>
          <ol>
            {list.map((c) => {
              const rank = c.eligible ? ++order : 0;
              return (
                <li key={c.provider} className="flex h-7 items-center gap-2 border-b border-line text-xs last:border-b-0">
                  <span className="num w-4 shrink-0 text-ink-3">{rank || "—"}</span>
                  <ProviderName id={c.provider} className={cx("min-w-0 flex-1", !c.eligible && "text-ink-3")} />
                  <span className="flex shrink-0 items-center gap-1.5 text-ink-3">
                    <Dot tone={c.eligible ? "ok" : "neutral"} />
                    {c.eligible ? "可用" : (candidateReason[c.reason ?? ""] ?? c.reason ?? "不可用")}
                  </span>
                </li>
              );
            })}
          </ol>
        </Group>
      )}

      {groups.map((group) => (
        <Group key={group.title ?? ""} title={group.title}>
          <dl>
            {group.rows.map((row) => (
              <Fact key={row.key} label={row.label} known={row.known}>
                {row.key === "provider" || row.key === "winner" || row.key === "engine" ? <ProviderName id={row.value} className="justify-end" /> : row.value}
              </Fact>
            ))}
          </dl>
        </Group>
      ))}

      {text ? (
        <Group title={running ? "模型正在写" : "模型写了什么"}>
          <Written text={text} live={running} />
        </Group>
      ) : null}

      {args && Object.keys(args).length > 0 && (
        <Group title="参数">
          <CodeBlock copy wrap className="max-h-56">
            {JSON.stringify(args, null, 2)}
          </CodeBlock>
        </Group>
      )}

      {blocks.map((block) => (
        <Group key={block.key} title={block.label}>
          <CodeBlock copy wrap className="max-h-56">
            {block.json}
          </CodeBlock>
        </Group>
      ))}
    </div>
  );
}
