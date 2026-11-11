import { useMemo } from "react";
import type { NodeStatus, TraceNode } from "../../lib/api";
import { duration } from "../../lib/format";
import { useNow } from "../../lib/motion";
import { buildTree, type TreeNode } from "../../lib/trace";
import { cx, Empty } from "../../ui/primitives";
import { ProviderKind } from "../ProviderName";
import { conclusion, kindLabel, statusLabel, titleOf } from "./wording";

const bar: Record<NodeStatus, string> = {
  running: "bg-signal-text",
  ok: "bg-ok",
  error: "bg-err",
  canceled: "bg-ink-3/50",
  cached: "bg-info",
  skipped: "bg-warn",
  limited: "bg-warn",
};
const word: Record<NodeStatus, string> = {
  running: "text-signal-text",
  ok: "text-ink-2",
  error: "text-err",
  canceled: "text-ink-3",
  cached: "text-info",
  skipped: "text-warn",
  limited: "text-warn",
};

interface Line {
  node: TreeNode;
  depth: number;
}

/** A provider that was passed over took no time, but belongs on the axis: it is why the next one was called. */
const noted = (node: TraceNode) => node.status === "skipped" || node.status === "limited";

function lines(node: TreeNode, depth: number, out: Line[]): Line[] {
  const shown = depth === 0 || node.status === "running" || !!node.duration_ms || noted(node);
  if (shown) out.push({ node, depth });
  for (const child of node.children) lines(child, shown ? depth + 1 : depth, out);
  return out;
}

/**
 * Everything of a call that took time, on one time axis and indented by what
 * it was part of: where the time went, what waited for what, what raced.
 */
export function Timeline({
  nodes,
  live = false,
  origin = 0,
  selected,
  onSelect,
  className,
}: {
  nodes: TraceNode[];
  live?: boolean;
  origin?: number;
  selected?: number;
  onSelect?: (id: number) => void;
  className?: string;
}) {
  const rows = useMemo(() => {
    const root = buildTree(nodes);
    return root ? lines(root, 0, []) : [];
  }, [nodes]);
  const ended = useMemo(() => nodes.reduce((max, n) => Math.max(max, n.start_ms + (n.duration_ms ?? 0)), 1), [nodes]);
  const now = useNow(live, 200);
  const span = live ? Math.max(ended, now - origin) : ended;
  if (rows.length === 0) return <Empty title="还没有收到这次调用的任何一步" />;
  return (
    <div className={cx("overflow-x-auto", className)} onClick={onSelect ? () => onSelect(0) : undefined}>
      <div className="min-w-[34rem]">
        <div className="num flex border-b border-line py-1.5 pr-4 text-2xs text-ink-3">
          <span className="w-64 shrink-0 pl-4 max-lg:w-52">节点</span>
          <span className="flex flex-1 justify-between">
            <span>0</span>
            <span>{duration(span / 2)}</span>
            <span>{duration(span)}</span>
          </span>
          <span className="w-28 shrink-0 text-right">状态 · 耗时</span>
        </div>
        <ol>
          {rows.map(({ node, depth }) => {
            const running = node.status === "running";
            const took = running ? Math.max(0, span - node.start_ms) : (node.duration_ms ?? 0);
            const left = Math.min(100, (node.start_ms / span) * 100);
            const kind = kindLabel[node.kind] ?? node.kind;
            const title = titleOf(node);
            const summary = title !== kind ? title : conclusion(node);
            const active = selected === node.id;
            return (
              <li
                key={node.id}
                role={onSelect ? "button" : undefined}
                tabIndex={onSelect ? 0 : undefined}
                aria-pressed={onSelect ? active : undefined}
                onClick={
                  onSelect &&
                  ((e) => {
                    e.stopPropagation();
                    onSelect(node.id);
                  })
                }
                onKeyDown={
                  onSelect &&
                  ((e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    e.stopPropagation();
                    onSelect(node.id);
                  })
                }
                className={cx(
                  "flex h-7 items-center border-b border-line pr-4 text-xs transition-colors last:border-b-0 focus-visible:outline-offset-[-2px]",
                  onSelect && "cursor-pointer",
                  active ? "bg-fill-strong" : onSelect && "hover:bg-fill",
                )}
              >
                <span className="flex w-64 shrink-0 items-center gap-1.5 pr-3 max-lg:w-52" style={{ paddingLeft: `${1 + Math.min(depth, 6) * 0.625}rem` }}>
                  <span className={cx("tag shrink-0", active && "text-ink")}>{kind}</span>
                  {node.kind === "attempt" ? (
                    <ProviderKind id={node.name ?? ""} icon="size-3" className="text-ink" />
                  ) : node.kind === "llm" || node.kind === "agent" ? (
                    <span className="num min-w-0 truncate text-ink">{node.name}</span>
                  ) : node.kind === "query" || node.kind === "worker" ? (
                    <span className="min-w-0 truncate text-ink">{node.name}</span>
                  ) : summary ? (
                    <span className={cx("min-w-0 truncate", title !== kind ? "text-ink" : "text-ink-2")}>{summary}</span>
                  ) : null}
                </span>
                <span className="relative h-1.5 flex-1 rounded-full bg-sunken">
                  <span
                    className={cx("absolute inset-y-0 min-w-0.5 origin-left rounded-full", !live && "animate-grow-x", bar[node.status])}
                    style={{ left: `${left}%`, width: `${Math.min(100 - left, (took / span) * 100)}%`, animationDelay: live ? undefined : `${Math.round((node.start_ms / span) * 360)}ms` }}
                  />
                </span>
                <span className={cx("num w-28 shrink-0 truncate text-right", word[node.status])} title={node.error}>
                  {node.status === "ok" ? "" : `${statusLabel[node.status]} `}
                  {noted(node) ? "" : duration(took)}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
