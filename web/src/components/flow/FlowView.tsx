import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TraceNode, TraceText } from "../../lib/api";
import { normalizeTrace } from "../../lib/trace";
import { modalOpen, tooltipOpen } from "../../ui/overlays";
import { cx, Empty } from "../../ui/primitives";
import { Flow } from "./Flow";
import { NodeDetail } from "./NodeDetail";
import { Timeline } from "./Timeline";

export interface FlowViewProps {
  nodes: TraceNode[];
  /** What the models of the call have written, by node. */
  text?: TraceText;
  live?: boolean;
  /** When the call began, by this browser's clock. Needed while it runs. */
  origin?: number;
  selected?: number;
  onSelect?: (id: number) => void;
  className?: string;
}

function TraceInspector({
  nodes: rawNodes,
  text,
  live = false,
  origin = 0,
  selected,
  onSelect,
  className,
  children,
}: FlowViewProps & { children: (selected: number | undefined, select: (id: number) => void) => ReactNode }) {
  const nodes = useMemo(() => normalizeTrace(rawNodes), [rawNodes]);
  const [picked, setPicked] = useState(0);
  const activeId = selected ?? picked;
  const select = useCallback(
    (id: number) => {
      const next = id === activeId ? 0 : id;
      if (selected === undefined) setPicked(next);
      onSelect?.(next);
    },
    [activeId, onSelect, selected],
  );
  const root = useMemo(() => nodes.find((n) => !n.parent) ?? nodes[0], [nodes]);
  const node = useMemo(() => (activeId ? nodes.find((n) => n.id === activeId) : undefined), [nodes, activeId]);
  const total = useMemo(() => nodes.reduce((max, n) => Math.max(max, n.start_ms + (n.duration_ms ?? 0)), 1), [nodes]);
  const shown = node ?? root;
  const sheet = useRef<HTMLElement>(null);
  const detail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sheet.current?.scrollTo({ top: 0 });
    detail.current?.scrollTo({ top: 0 });
  }, [shown?.id]);

  useEffect(() => {
    if (!node) return;
    // Ahead of the panel the view may sit in, which Escape would close.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || modalOpen() || tooltipOpen()) return;
      e.preventDefault();
      select(0);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [node, select]);

  if (!shown) {
    return live ? <Empty title="还没有收到这次调用的任何一步" /> : null;
  }

  return (
    // A flex box, so that the flow fills whatever height the view is given.
    <div className={cx("@container relative flex", Boolean(node) && "@max-3xl:min-h-80", className)}>
      <div className="flex min-w-0 flex-1 items-stretch">
        {children(node?.id, select)}
        <aside
          ref={sheet}
          className={cx(
            "w-[22rem] shrink-0 border-l border-line bg-surface",
            "@max-3xl:absolute @max-3xl:inset-y-0 @max-3xl:right-0 @max-3xl:z-10 @max-3xl:w-[min(22rem,calc(100%-1.5rem))] @max-3xl:animate-slide @max-3xl:overflow-y-auto @max-3xl:overscroll-contain @max-3xl:border-line-strong @max-3xl:bg-overlay @max-3xl:shadow-overlay",
            !node && "@max-3xl:hidden",
          )}
        >
          <div ref={detail} className="sticky top-0 max-h-dvh overflow-y-auto overscroll-contain @max-3xl:static @max-3xl:max-h-none @max-3xl:overflow-visible">
            <NodeDetail
              node={shown}
              text={text?.[shown.id]}
              total={total}
              origin={live ? origin : 0}
              onClose={node ? () => select(0) : undefined}
              closeClassName={shown.id === root?.id ? "@3xl:hidden" : undefined}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * A flow with the facts of the node that is picked beside it. Where the view
 * is wide the facts have a column of their own, which shows the call itself
 * until a node is picked; where it is narrow they slide over the flow.
 */
export function FlowView(props: FlowViewProps) {
  const { nodes, live = false, origin = 0 } = props;
  return (
    <TraceInspector {...props}>
      {(selected, select) => <Flow nodes={nodes} live={live} origin={origin} selected={selected} onSelect={select} className="min-w-0 flex-1" />}
    </TraceInspector>
  );
}

/**
 * A timeline with the facts of the node that is picked beside it.
 */
export function TimelineView(props: FlowViewProps) {
  const { nodes, live = false, origin = 0 } = props;
  return (
    <TraceInspector {...props}>
      {(selected, select) => <Timeline nodes={nodes} live={live} origin={origin} selected={selected} onSelect={select} className="min-w-0 flex-1" />}
    </TraceInspector>
  );
}
