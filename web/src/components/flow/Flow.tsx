import { BookOpen, Bot, Braces, ChevronLeft, ChevronRight, CornerDownLeft, Globe, LogIn, Microscope, ScanText, type LucideIcon } from "lucide-react";
import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { NodeStatus, TraceNode } from "../../lib/api";
import { duration } from "../../lib/format";
import { useNow } from "../../lib/motion";
import { attr, buildTree, type TreeNode } from "../../lib/trace";
import { cx, Dot } from "../../ui/primitives";
import { ProviderName } from "../ProviderName";
import { candidateReason, candidates, conclusion, isPill, statusLabel, statusTone, subject, titleOf } from "./wording";

/*
 * A call drawn as a flow: what happened runs down one spine, top to bottom,
 * and what ran at the same moment sits side by side. A decision is a pill
 * with its conclusion on it; a call that took time is a card with its
 * status, its duration and where in the request it sat.
 */

/* ---------- Clock and selection ---------- */

interface Clock {
  /** The call's length so far, in ms: its duration once it is over. */
  total: number;
  live: boolean;
}

const ClockContext = createContext<Clock>({ total: 1, live: false });

/** Keeps the time of a running call. It is the only part of a flow that redraws on a timer. */
function ClockProvider({ live, origin, total, children }: { live: boolean; origin: number; total: number; children: ReactNode }) {
  const now = useNow(live, 200);
  const since = live ? Math.max(total, now - origin) : total;
  const value = useMemo(() => ({ total: Math.max(1, since), live }), [since, live]);
  return <ClockContext.Provider value={value}>{children}</ClockContext.Provider>;
}

interface Selection {
  selected?: number;
  onSelect?: (id: number) => void;
  /** Stored calls play their order out once; a live one draws nodes as they come. */
  replay: number;
}

const SelectionContext = createContext<Selection>({ replay: 0 });

/* ---------- From a tree to what is drawn ---------- */

type Item = { t: "node"; node: TreeNode } | { t: "par"; nodes: TreeNode[] } | { t: "steps"; nodes: TreeNode[] };

/** Kinds that may run at the same moment as a sibling of their kind. */
const concurrent = new Set(["attempt", "query", "llm"]);
/** Kinds whose children are drawn inside their own card. */
const enclosing = new Set(["attempt", "tool"]);

const endOf = (node: TraceNode) => (node.status === "running" ? Infinity : node.start_ms + (node.duration_ms ?? 0));

/** Whether `node` began while the group before it was still going. */
function overlaps(node: TraceNode, groupEnd: number): boolean {
  const trigger = attr<string>(node, "trigger");
  if (trigger === "after_failure" || trigger === "after_rate_limit" || trigger === "slot_freed" || trigger === "retry") return false;
  return node.start_ms < groupEnd - 1;
}

function itemsOf(node: TreeNode): Item[] {
  if (enclosing.has(node.kind)) return [{ t: "node", node }];
  return [{ t: "node", node }, ...sequence(node.children)];
}

function sequence(list: TreeNode[]): Item[] {
  // The budget running out is what makes the next step the report: it reads before that step, though it is recorded just after the step begins.
  const children = [...list];
  for (let i = 1; i < children.length; i++) {
    const [before, node] = [children[i - 1], children[i]];
    if (node.kind === "wrap_up" && before.kind === "step" && (attr<boolean>(before, "final") || before.start_ms >= node.start_ms)) [children[i - 1], children[i]] = [node, before];
  }
  const out: Item[] = [];
  for (let i = 0; i < children.length; ) {
    const node = children[i];
    if (node.kind === "step") {
      const steps: TreeNode[] = [];
      while (i < children.length && children[i].kind === "step") steps.push(children[i++]);
      out.push({ t: "steps", nodes: steps });
      continue;
    }
    i++;
    if (!concurrent.has(node.kind)) {
      out.push(...itemsOf(node));
      continue;
    }
    const group = [node];
    let end = endOf(node);
    while (i < children.length && children[i].kind === node.kind && overlaps(children[i], end)) {
      end = Math.max(end, endOf(children[i]));
      group.push(children[i++]);
    }
    if (group.length > 1) out.push({ t: "par", nodes: group });
    else out.push(...itemsOf(node));
  }
  return out;
}

/* ---------- Lines ---------- */

type Line = "taken" | "live" | "dropped";

/** How the line into a node is drawn: taken, still being walked, or a branch that led nowhere. */
function lineOf(status: NodeStatus | undefined): Line {
  if (status === "running") return "live";
  if (status === "canceled" || status === "skipped" || status === "limited") return "dropped";
  return "taken";
}

const lineColor: Record<Line, string> = {
  taken: "border-line-strong",
  live: "border-signal-text",
  dropped: "border-line-strong border-dashed",
};

const X = "left-[calc(50%-0.5px)]";

/** The vertical line between two things on the spine. */
function Rail({ line = "taken", className }: { line?: Line; className?: string }) {
  return (
    <div aria-hidden className={cx("relative h-4 w-full shrink-0", className)}>
      <span className={cx("absolute inset-y-0 w-0 origin-top animate-grow-y border-l", X, lineColor[line])} />
    </div>
  );
}

/**
 * One column's share of the bar a fork hangs from, or of the bar its columns
 * join below: the bar's half to each side, and the column's own line to it.
 */
function Branch({ side, line, stub, left, right }: { side: "top" | "bottom"; line: Line; stub: boolean; left: boolean; right: boolean }) {
  const top = side === "top";
  const edge = top ? "top-0" : "bottom-0";
  const bar = cx("absolute h-0 border-t border-line-strong", edge);
  // A column at the end of the bar turns into it with a rounded corner.
  const corner = stub && left !== right;
  return (
    <div aria-hidden className={cx("relative w-full animate-in", top ? "h-4 shrink-0" : "min-h-4 flex-1")}>
      {corner ? (
        <>
          <span
            className={cx(
              "absolute size-[5px] border-line-strong",
              edge,
              top ? "border-t" : "border-b",
              right ? cx(X, "border-l", top ? "rounded-tl-ctl" : "rounded-bl-ctl") : cx("right-[calc(50%-0.5px)] border-r", top ? "rounded-tr-ctl" : "rounded-br-ctl"),
            )}
          />
          <span className={cx(bar, right ? "-right-1.5 left-[calc(50%+4.5px)]" : "right-[calc(50%+4.5px)] -left-1.5")} />
          <span className={cx("absolute w-0 border-l", X, top ? "top-[5px] bottom-0" : "top-0 bottom-[5px]", lineColor[line])} />
        </>
      ) : (
        <>
          {left && <span className={cx(bar, "right-1/2 -left-1.5")} />}
          {right && <span className={cx(bar, "-right-1.5 left-1/2")} />}
          {stub && <span className={cx("absolute inset-y-0 w-0 border-l", X, lineColor[line])} />}
        </>
      )}
    </div>
  );
}

/**
 * Which halves of the bar each of `n` columns draws, when the columns in
 * `joined` hang from it and the spine meets it at the middle.
 */
function bars(n: number, joined: boolean[]): { left: boolean; right: boolean }[] {
  const middle = (n - 1) / 2;
  const at = joined.flatMap((yes, i) => (yes ? [i] : []));
  const lo = Math.min(middle, ...at);
  const hi = Math.max(middle, ...at);
  return joined.map((_, i) => ({ left: lo <= i - 0.5 && hi >= i, right: lo <= i && hi >= i + 0.5 }));
}

/* ---------- Pieces of a node ---------- */

function useSelect(node: TraceNode) {
  const { selected, onSelect, replay } = useContext(SelectionContext);
  const { total } = useContext(ClockContext);
  return {
    selected: selected === node.id,
    // A stored call plays out in the order it ran, over a third of a second.
    style: replay ? ({ animationDelay: `${Math.round((Math.min(node.start_ms, replay) / replay) * 320)}ms`, animationFillMode: "backwards" } satisfies CSSProperties) : undefined,
    total,
    props: onSelect
      ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-pressed": selected === node.id,
          onClick: (e: { stopPropagation: () => void }) => {
            e.stopPropagation();
            onSelect(node.id);
          },
          onKeyDown: (e: KeyboardEvent) => {
            if (e.target !== e.currentTarget) return;
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            onSelect(node.id);
          },
        }
      : {},
  };
}

/** How long a node took; it counts while the node runs. */
function Took({ node, className }: { node: TraceNode; className?: string }) {
  const { total } = useContext(ClockContext);
  const running = node.status === "running";
  if (!running && !node.duration_ms) return null;
  return <span className={cx("num shrink-0", className)}>{duration(running ? Math.max(0, total - node.start_ms) : (node.duration_ms ?? 0))}</span>;
}

const barColor: Record<NodeStatus, string> = {
  running: "bg-signal-text",
  ok: "bg-ok",
  error: "bg-err",
  canceled: "bg-ink-3/60",
  cached: "bg-info",
  skipped: "bg-warn",
  limited: "bg-warn",
};

/** Where in the request a node sat: its span on the call's own time axis. */
function TimeBar({ node }: { node: TraceNode }) {
  const { total } = useContext(ClockContext);
  const running = node.status === "running";
  const span = running ? Math.max(0, total - node.start_ms) : (node.duration_ms ?? 0);
  const left = Math.min(100, (node.start_ms / total) * 100);
  return (
    <span aria-hidden className="relative block h-0.5 overflow-hidden rounded-full bg-line">
      <span className={cx("absolute inset-y-0 min-w-0.5 rounded-full", barColor[node.status])} style={{ left: `${left}%`, width: `${Math.min(100 - left, (span / total) * 100)}%` }} />
    </span>
  );
}

function Status({ node }: { node: TraceNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-ink-2">
      <Dot tone={statusTone[node.status]} live={node.status === "running"} />
      {statusLabel[node.status]}
    </span>
  );
}

const frame = (node: TraceNode, selected: boolean) =>
  cx(
    "border bg-surface text-left shadow-panel transition-[border-color,box-shadow] focus-visible:outline-offset-1",
    selected
      ? "border-signal-text ring-1 ring-signal-text"
      : node.status === "running"
        ? "border-signal-text/55 hover:border-signal-text"
        : "border-line hover:border-line-strong hover:shadow-raise",
    (node.status === "skipped" || node.status === "limited" || node.status === "canceled") && !selected && "border-dashed",
  );

/* ---------- Pill: a decision ---------- */

const markTone: Record<NodeStatus, string> = {
  running: "bg-signal-text animate-pulse-dot",
  ok: "bg-ink-3",
  error: "bg-err",
  canceled: "bg-ink-3",
  cached: "bg-info",
  skipped: "bg-warn",
  limited: "bg-warn",
};

function Pill({ node, fill }: { node: TreeNode; fill?: boolean }) {
  const { selected, style, props } = useSelect(node);
  const says = conclusion(node);
  const result = node.kind === "result";
  return (
    <div
      {...props}
      style={style}
      className={cx(
        "flex h-7 shrink-0 animate-in items-center gap-2 rounded-full px-3 text-xs",
        fill ? "max-w-full" : "max-w-[min(26rem,calc(100cqw-2rem))]",
        frame(node, selected),
        props.role && "cursor-pointer",
      )}
    >
      {result ? (
        <CornerDownLeft className={cx("size-3 shrink-0", node.status === "error" ? "text-err" : node.status === "ok" ? "text-ok" : "text-ink-3")} />
      ) : (
        // A decision is marked with a diamond, a call with the dot of its state.
        <span aria-hidden className={cx("size-1.5 shrink-0 rotate-45", markTone[node.status])} />
      )}
      <span className="shrink-0 text-ink-3">{titleOf(node)}</span>
      {says && <span className={cx("min-w-0 truncate", node.status === "error" ? "text-err" : "text-ink")}>{says}</span>}
      <Took node={node} className="text-ink-3" />
    </div>
  );
}

/* ---------- Card: something that took time ---------- */

const toolIcon: Record<string, LucideIcon> = { search: Globe, dev_search: Braces, fetch: ScanText, read_page: BookOpen, research: Microscope };

function Glyph({ node }: { node: TraceNode }) {
  const Icon = node.kind === "call" ? LogIn : node.kind === "llm" ? Bot : node.kind === "agent" ? Microscope : node.kind === "tool" ? (toolIcon[node.name ?? ""] ?? Globe) : undefined;
  return Icon ? <Icon aria-hidden className="size-3.5 shrink-0 text-ink-3" /> : null;
}

function Name({ node }: { node: TraceNode }) {
  if (node.kind === "attempt") return <ProviderName id={node.name ?? ""} className="font-medium" />;
  if (node.kind === "llm" || node.kind === "agent") return <span className="num min-w-0 truncate font-medium">{node.name}</span>;
  if (node.kind === "query") return <span className="min-w-0 truncate font-medium">{node.name}</span>;
  if (node.kind === "worker") return <span className="min-w-0 truncate font-medium">{node.name}</span>;
  return <span className="min-w-0 truncate font-medium">{titleOf(node)}</span>;
}

const cardLabel: Record<string, string> = { query: "查询", agent: "研究", call: "入口" };

function Card({ node, fill }: { node: TreeNode; fill?: boolean }) {
  const { selected, style, props } = useSelect(node);
  const says = conclusion(node);
  const asked = node.kind === "call" ? subject(node) : "";
  const inner = enclosing.has(node.kind) ? node.children : [];
  const timed = node.status === "running" || !!node.duration_ms;
  return (
    <div
      {...props}
      style={style}
      className={cx("shrink-0 animate-in rounded-ctl", fill ? "w-full" : "w-72 max-w-[calc(100cqw-2rem)]", frame(node, selected), props.role && "cursor-pointer")}
    >
      <div className="flex flex-col gap-1 px-2.5 pt-2 pb-2">
        <div className="flex items-center gap-2 text-sm">
          {cardLabel[node.kind] && <span className="tag shrink-0">{cardLabel[node.kind]}</span>}
          <Glyph node={node} />
          <Name node={node} />
          <span className="ml-auto">
            <Status node={node} />
          </span>
        </div>
        {asked && <div className="num truncate text-xs text-ink-2">{asked}</div>}
        {(says || timed) && (
          <div className="flex items-baseline justify-between gap-3 text-xs text-ink-3">
            <span className="min-w-0 truncate">{says}</span>
            <Took node={node} className="text-ink-2" />
          </div>
        )}
        {node.error && node.status === "error" && <div className="num line-clamp-2 text-xs break-words text-err">{node.error}</div>}
        {timed && node.kind !== "call" && <TimeBar node={node} />}
      </div>
      {inner.length > 0 && (
        <div className="border-t border-line">
          {inner.map((child) => (
            <Inner key={child.id} node={child} />
          ))}
        </div>
      )}
    </div>
  );
}

/** What happened inside a call: the workers a fetcher tried, a wait for its quota. */
function Inner({ node }: { node: TreeNode }) {
  const { selected, props } = useSelect(node);
  return (
    <div
      {...props}
      className={cx(
        "flex h-7 items-center gap-2 border-b border-line px-2.5 text-xs last:border-b-0",
        selected ? "bg-fill-strong" : props.role && "cursor-pointer hover:bg-fill",
      )}
    >
      <Dot tone={statusTone[node.status]} live={node.status === "running"} />
      <span className="shrink-0 text-ink-2">{node.kind === "worker" ? node.name : titleOf(node)}</span>
      <span className="min-w-0 flex-1 truncate text-ink-3">{node.error || conclusion(node) || (node.kind === "worker" ? statusLabel[node.status] : "")}</span>
      <Took node={node} className="text-ink-3" />
    </div>
  );
}

/* ---------- Route: the candidates and who was left out ---------- */

function RouteCard({ node, fill }: { node: TreeNode; fill?: boolean }) {
  const { selected, style, props } = useSelect(node);
  const list = candidates(node);
  let order = 0;
  return (
    <div
      {...props}
      style={style}
      className={cx("shrink-0 animate-in rounded-ctl", fill ? "w-full" : "w-72 max-w-[calc(100cqw-2rem)]", frame(node, selected), props.role && "cursor-pointer")}
    >
      <div className="flex items-center gap-2 px-2.5 pt-2 text-xs">
        <span aria-hidden className={cx("size-1.5 shrink-0 rotate-45", markTone[node.status])} />
        <span className="shrink-0 text-ink-3">路由</span>
        <span className={cx("min-w-0 truncate", node.status === "error" ? "text-err" : "text-ink")}>{conclusion(node)}</span>
      </div>
      {list.length > 0 ? (
        <ol className="flex flex-wrap gap-1 px-2.5 pt-1.5 pb-2">
          {list.map((c) => (
            <li
              key={c.provider}
              className={cx(
                "inline-flex h-5 max-w-full items-center gap-1 rounded-tag px-1.5 text-2xs",
                c.eligible ? "bg-fill text-ink-2" : "border border-dashed border-line-strong text-ink-3",
              )}
            >
              {c.eligible && <span className="num text-ink-3">{++order}</span>}
              <ProviderName id={c.provider} icon="size-3" className={cx(!c.eligible && "opacity-60")} />
              {!c.eligible && c.reason && <span className="shrink-0">{candidateReason[c.reason] ?? c.reason}</span>}
            </li>
          ))}
        </ol>
      ) : (
        <div className="pb-2" />
      )}
      {node.error && node.status === "error" && <div className="num px-2.5 pb-2 text-xs break-words text-err">{node.error}</div>}
    </div>
  );
}

function NodeView({ node, fill }: { node: TreeNode; fill?: boolean }) {
  if (node.kind === "route") return <RouteCard node={node} fill={fill} />;
  return isPill(node) ? <Pill node={node} fill={fill} /> : <Card node={node} fill={fill} />;
}

/* ---------- Forks ---------- */

function Par({ nodes, depth, closed }: { nodes: TreeNode[]; depth: number; closed: boolean }) {
  const n = nodes.length;
  // The columns share the canvas down to a width a card still reads at; a fork inside a fork cannot.
  const width = depth > 0 ? "12.5rem" : `clamp(12.5rem, calc((100cqw - 2rem - ${(n - 1) * 0.75}rem) / ${n}), 16rem)`;
  // A branch that was dropped ends where it stopped; the others come back to the spine.
  const kept = nodes.map((node) => lineOf(node.status) !== "dropped");
  const back = kept.some(Boolean) ? kept : nodes.map(() => true);
  const above = bars(n, nodes.map(() => true));
  const below = bars(n, back);
  return (
    <div className="grid shrink-0 gap-x-3" style={{ gridTemplateColumns: `repeat(${n}, ${width})` }}>
      {nodes.map((node, i) => (
        <div key={node.id} className="flex min-w-0 flex-col items-center">
          <Branch side="top" stub line={lineOf(node.status)} {...above[i]} />
          <Items items={itemsOf(node)} depth={depth + 1} fill />
          {closed && <Branch side="bottom" stub={back[i]} line={lineOf(node.status)} {...below[i]} />}
        </div>
      ))}
    </div>
  );
}

/* ---------- Research steps ---------- */

function Steps({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ol className="w-[min(46rem,calc(100cqw-2rem))] shrink-0 animate-in rounded-panel border border-line bg-surface">
      {nodes.map((node) => (
        <Step key={node.id} node={node} />
      ))}
    </ol>
  );
}

function Step({ node }: { node: TreeNode }) {
  const { selected, props } = useSelect(node);
  const tools = node.children.filter((c) => c.kind === "tool");
  const others = node.children.filter((c) => c.kind !== "tool");
  const note = attr<string>(node, "note");
  const [open, setOpen] = useState<number | null>(null);
  const running = node.status === "running";
  return (
    <li className="flex animate-in border-b border-line last:border-b-0">
      <div className="flex w-10 shrink-0 flex-col items-center pt-2.5">
        <span className={cx("tag", running || selected ? "text-signal-text" : "text-ink-3")}>{(node.name ?? "").padStart(2, "0")}</span>
        <span aria-hidden className={cx("mt-1.5 w-0 flex-1 border-l", running ? "border-signal-text" : "border-line")} />
      </div>
      <div className="min-w-0 flex-1 py-2 pr-2.5">
        <div {...props} className={cx("-ml-1.5 flex min-h-7 items-center gap-2 rounded-ctl px-1.5 text-xs", selected ? "bg-fill-strong" : props.role && "cursor-pointer hover:bg-fill/60")}>
          <Dot tone={statusTone[node.status]} live={running} />
          <span className="shrink-0 text-ink-2">{running && tools.length === 0 ? "模型在想下一步" : attr<boolean>(node, "final") ? "模型写报告" : "模型决定"}</span>
          <span className="num min-w-0 flex-1 truncate text-ink-3">{conclusion(node).replace(/^写报告( · )?/, "")}</span>
          {node.status === "error" && node.error ? (
            <span className="num min-w-0 truncate text-err">{node.error}</span>
          ) : (
            node.status === "canceled" && <span className="shrink-0 text-ink-3">{statusLabel.canceled}</span>
          )}
          <Took node={node} className="text-ink-3" />
        </div>
        {note && <p className="mt-1 line-clamp-2 text-xs text-ink-2">{note}</p>}
        {tools.length > 0 && (
          <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-1.5">
            {tools.map((tool) => (
              <ToolCard key={tool.id} node={tool} open={open === tool.id} onToggle={() => setOpen(open === tool.id ? null : tool.id)} />
            ))}
          </div>
        )}
        {others.length > 0 && (
          <div className="mt-2 flex flex-col items-center">
            <Items items={sequence(others)} depth={1} />
          </div>
        )}
      </div>
    </li>
  );
}

/** A tool the agent called. It opens in place into the flow of that call. */
function ToolCard({ node, open, onToggle }: { node: TreeNode; open: boolean; onToggle: () => void }) {
  const { selected, props } = useSelect(node);
  const inside = node.children.length > 0;
  const asked = subject(node);
  return (
    <div className={cx("animate-in rounded-ctl", frame(node, selected), open && "col-span-full")}>
      <div {...props} className={cx("flex flex-col gap-1 px-2.5 py-2", props.role && "cursor-pointer")}>
        <div className="flex items-center gap-2 text-xs">
          <Glyph node={node} />
          <span className="shrink-0 font-medium text-ink">{titleOf(node)}</span>
          <span className="ml-auto flex items-center gap-2">
            <Took node={node} className="text-ink-3" />
            <Dot tone={statusTone[node.status]} live={node.status === "running"} />
            <span className="sr-only">{statusLabel[node.status]}</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="num min-w-0 flex-1 truncate text-xs text-ink-3">{asked || " "}</span>
          {inside && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "收起这次调用的流程" : "展开这次调用的流程"}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="-my-1 -mr-1 inline-flex h-6 shrink-0 items-center gap-0.5 rounded-ctl px-1.5 text-2xs text-ink-3 transition-colors hover:bg-fill hover:text-ink"
            >
              <span>流程</span>
              <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} />
            </button>
          )}
        </div>
        {node.status === "error" && node.error && <div className="num line-clamp-2 text-xs break-words text-err">{node.error}</div>}
      </div>
      {open && (
        <div className="flow-canvas overflow-x-auto rounded-b-ctl border-t border-line">
          <div className="flex w-max min-w-full flex-col items-center px-3 py-4">
            <Items items={sequence(node.children)} depth={1} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- The spine ---------- */

function itemLine(item: Item): Line {
  if (item.t === "node") return lineOf(item.node.status);
  if (item.nodes.some((n) => n.status === "running")) return "live";
  if (item.nodes.every((n) => lineOf(n.status) === "dropped")) return "dropped";
  return "taken";
}

function Items({ items, depth, fill }: { items: Item[]; depth: number; fill?: boolean }) {
  return (
    <>
      {items.map((item, i) => {
        const before = i > 0 && <Rail line={itemLine(item)} />;
        const key = item.t === "node" ? item.node.id : `${item.t}${item.nodes[0].id}`;
        return (
          <div key={key} className="flex w-full min-w-0 flex-col items-center">
            {before}
            {item.t === "node" ? (
              <NodeView node={item.node} fill={fill} />
            ) : item.t === "par" ? (
              <Par nodes={item.nodes} depth={depth} closed={i < items.length - 1} />
            ) : (
              <Steps nodes={item.nodes} />
            )}
          </div>
        );
      })}
    </>
  );
}

export interface FlowProps {
  nodes: TraceNode[];
  /** The call is still running: durations count and nodes are drawn as they come. */
  live?: boolean;
  /** When the call began, by this browser's clock. Needed while it runs. */
  origin?: number;
  selected?: number;
  onSelect?: (id: number) => void;
  className?: string;
}

export const Flow = memo(function Flow({ nodes, live = false, origin = 0, selected, onSelect, className }: FlowProps) {
  const root = useMemo(() => buildTree(nodes), [nodes]);
  const items = useMemo(() => (root ? itemsOf(root) : []), [root]);
  const total = useMemo(() => nodes.reduce((max, n) => Math.max(max, n.start_ms + (n.duration_ms ?? 0)), 1), [nodes]);
  // Whether the flow was first drawn for a call that was already over.
  const [stored] = useState(!live);
  const selection = useMemo(() => ({ selected, onSelect, replay: stored && !live ? total : 0 }), [selected, onSelect, stored, live, total]);

  // A flow wider than its view opens on its spine, which is its middle, and stays on it as the flow grows, until it is scrolled by hand.
  const canvas = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const placed = useRef(0);
  const moved = useRef(false);
  const [edges, setEdges] = useState({ left: false, right: false });
  const drawn = root !== null;
  const updateEdges = (box: HTMLDivElement) => {
    const left = box.scrollLeft > 4;
    const right = box.scrollLeft + box.clientWidth < box.scrollWidth - 4;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };
  useLayoutEffect(() => {
    moved.current = false;
  }, [root?.id, root?.name]);
  useLayoutEffect(() => {
    const box = canvas.current;
    const inner = content.current;
    if (!box || !inner) return;
    const center = () => {
      if (!moved.current) {
        placed.current = Math.max(0, (box.scrollWidth - box.clientWidth) / 2);
        box.scrollLeft = placed.current;
      }
      updateEdges(box);
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(box);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [drawn]);

  if (!root) return null;
  const pan = (dir: -1 | 1) => {
    const box = canvas.current;
    if (!box) return;
    moved.current = true;
    box.scrollBy({ left: dir * Math.max(180, Math.round(box.clientWidth * 0.65)), behavior: "smooth" });
  };
  return (
    <div className={cx("flow-canvas @container relative flex min-w-0 flex-col", className)}>
      {edges.left && (
        <>
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-8 bg-linear-to-r from-bg via-bg/80 to-transparent" />
          <button
            type="button"
            aria-label="向左查看分支"
            onClick={(e) => {
              e.stopPropagation();
              pan(-1);
            }}
            className="absolute top-1/2 left-2 z-[2] grid size-7 -translate-y-1/2 place-items-center rounded-full bg-overlay text-ink-2 shadow-overlay transition-colors hover:text-ink"
          >
            <ChevronLeft className="size-3.5" />
          </button>
        </>
      )}
      {edges.right && (
        <>
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-8 bg-linear-to-l from-bg via-bg/80 to-transparent" />
          <button
            type="button"
            aria-label="向右查看分支"
            onClick={(e) => {
              e.stopPropagation();
              pan(1);
            }}
            className="absolute top-1/2 right-2 z-[2] grid size-7 -translate-y-1/2 place-items-center rounded-full bg-overlay text-ink-2 shadow-overlay transition-colors hover:text-ink"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </>
      )}
      <div
        ref={canvas}
        className="min-w-0 flex-1 overflow-x-auto"
        onClick={onSelect ? () => onSelect(0) : undefined}
        onWheel={(e) => {
          if (Math.abs(e.deltaX) > 0 || e.shiftKey) moved.current = true;
        }}
        onTouchMove={() => {
          moved.current = true;
        }}
        onPointerDown={(e) => {
          const box = e.currentTarget;
          if (e.clientY > box.getBoundingClientRect().top + box.clientHeight) moved.current = true;
        }}
        onScroll={(e) => {
          updateEdges(e.currentTarget);
        }}
      >
        <div ref={content} className="flex w-max min-w-full flex-col items-center px-4 py-6">
          <ClockProvider live={live} origin={origin} total={total}>
            <SelectionContext.Provider value={selection}>
              <Items items={items} depth={0} />
            </SelectionContext.Provider>
          </ClockProvider>
        </div>
      </div>
    </div>
  );
});
