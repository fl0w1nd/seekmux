import { useQuery } from "@tanstack/react-query";
import { Boxes, Code, CornerDownLeft, History, Play, RotateCcw, ScrollText, Sparkles, Square, Workflow, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { FlowView, TimelineView } from "../../components/flow/FlowView";
import { LivePhase } from "../../components/flow/LivePhase";
import { ProviderPicker } from "../../components/ProviderPicker";
import { OptionFields, type RouteParams } from "../../components/RouteOptions";
import { api, APIError, stoppedHere, type LogEntry, type RoutedTool, type RouteTuning, type TraceNode, type TraceText } from "../../lib/api";
import { useConfig } from "../../lib/config";
import { ago, compact, dateTime, duration, toolPage } from "../../lib/format";
import { useNow } from "../../lib/motion";
import { activeOf, legacyTrace } from "../../lib/trace";
import { Markdown } from "../../ui/markdown";
import { Dialog, Drawer, Popover, useToast } from "../../ui/overlays";
import { Badge, Button, CodeBlock, cx, Dot, Empty, Notice, Segmented, Spinner, TabList, TabPanel, Tabs, Tooltip } from "../../ui/primitives";

const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/* ---------- Stage ---------- */

/**
 * The head of a playground page and its workbench: what goes into a call
 * above, the pane the call answers into below, both the width of the page.
 * The past runs are a drawer, opened from the head (`history`).
 */
export function Stage({
  tool,
  title,
  description,
  actions,
  history,
  output,
  children,
}: {
  tool?: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  /** The way to the past runs, at the end of the head. */
  history?: ReactNode;
  /** The pane under the composer. */
  output: ReactNode;
  /** The composer. */
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="tag text-signal-text">调试台</span>
            {tool && <span className="tag">· {tool}</span>}
          </div>
          <h1 className="mt-0.5 text-xl font-medium tracking-tight">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-3">{description}</p>
        </div>
        {(actions || history) && (
          <div className="flex items-center gap-2">
            {actions}
            {history}
          </div>
        )}
      </header>
      {children}
      {output}
    </div>
  );
}

/* ---------- Composer ---------- */

/** The style of the main input of a composer, which has no frame of its own. */
export const bare = "block w-full bg-transparent px-4 text-base text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50";

/**
 * Structured request workbench:
 * 1. Top instrument bar (`tools` on the left, `toolbarRight` on the right)
 * 2. Collapsible parameter panel (`panel`, in two columns with `splitPanel` where the composer is wide enough)
 * 3. Main structured input area (`children`)
 * 4. Bottom action bar (`footer` on the left for examples/counters, `actions` on the right for execution)
 */
export function Composer({
  children,
  tools,
  toolbarRight,
  footer,
  actions,
  panel,
  open,
  splitPanel = false,
}: {
  children: ReactNode;
  /** Left side of the top instrument bar: primary mode, provider, and quick filters. */
  tools: ReactNode;
  /** Right side of the top instrument bar: summary, parameter toggle, MCP code view. */
  toolbarRight?: ReactNode;
  /** Left side of the bottom bar: examples, input counters, status hints. */
  footer?: ReactNode;
  /** Right side of the bottom bar, ending in the primary RunButton. */
  actions: ReactNode;
  panel?: ReactNode;
  open?: boolean;
  /** Whether the parameter panel splits into two columns where the composer is wide. The composer is a container: what is inside lays itself out by `@` variants, not by the window. */
  splitPanel?: boolean;
}) {
  return (
    <div className="@container overflow-hidden rounded-panel border border-line-strong bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line bg-sunken/45 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{tools}</div>
        {toolbarRight && <div className="ml-auto flex shrink-0 items-center gap-1.5">{toolbarRight}</div>}
      </div>

      {panel !== undefined && (
        <Collapsible.Root open={open}>
          <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-fold-up data-[state=open]:animate-fold-down">
            <div
              className={cx(
                "border-b border-line bg-sunken/20 [&>*]:border-line",
                splitPanel ? "grid divide-y @3xl:grid-cols-2 @3xl:divide-x @3xl:divide-y-0" : "flex flex-col divide-y",
              )}
            >
              {panel}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      )}

      <div className="bg-surface">{children}</div>

      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line bg-sunken/25 px-3.5 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{footer}</div>
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}

/** A button of the composer bar that names a setting and shows its value. */
export function Chip({
  icon,
  label,
  value,
  changed,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> & {
  icon?: ReactNode;
  label?: ReactNode;
  value?: ReactNode;
  /** Marks a value that is not the configured one. */
  changed?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-7 max-w-64 shrink-0 items-center gap-1.5 rounded-ctl border border-line bg-surface px-2.5 text-xs text-ink-2 transition-colors",
        "hover:border-line-strong hover:text-ink aria-expanded:border-line-strong aria-expanded:bg-raised aria-expanded:text-ink",
        "aria-pressed:border-line-strong aria-pressed:bg-raised aria-pressed:text-ink [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ink-3",
        className,
      )}
      {...rest}
    >
      {icon}
      {label && <span className={value !== undefined ? "text-ink-3" : undefined}>{label}</span>}
      {value !== undefined && <span className="truncate font-medium text-ink">{value}</span>}
      {changed && <Dot tone="signal" />}
    </button>
  );
}

/** The values of the parameters panel in a few words; a click opens the panel. */
export function Summary({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="num min-w-0 truncate px-1.5 text-xs text-ink-3 transition-colors hover:text-ink">
      {children}
    </button>
  );
}

/** The primary action of a composer. While its call runs it is the way to stop it, when the call can be stopped. */
export function RunButton({ label, loading, disabled, onClick, onStop }: { label: string; loading: boolean; disabled: boolean; onClick: () => void; onStop?: () => void }) {
  if (loading && onStop) {
    return (
      <Button icon={<Square />} onClick={onStop}>
        停止
      </Button>
    );
  }
  return (
    <Button variant="primary" icon={<Play />} loading={loading} disabled={disabled} onClick={onClick}>
      {label}
      <kbd className="num flex items-center text-2xs opacity-60">
        {mod}
        <CornerDownLeft className="size-3!" />
      </kbd>
    </Button>
  );
}

export const onModEnter = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    run();
  }
};

/** Ready-made inputs inside the composer footer bar, while the input is empty or holds one of them. */
export function Examples({
  items,
  current,
  mono = true,
  onPick,
  onClear,
}: {
  items: string[];
  current?: string;
  mono?: boolean;
  onPick: (item: string) => void;
  onClear?: () => void;
}) {
  const hasInput = Boolean(current && current.trim() !== "");
  // Once something of one's own is typed, the examples step aside; while an example is in, the others stay a click away.
  const own = hasInput && !items.some((item) => item.trim() === current?.trim());
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {!own && (
        <span className="tag flex items-center gap-1 text-ink-3">
          <Sparkles className="size-3" />
          示例
        </span>
      )}
      {!own && items.map((item) => {
        const active = current?.trim() === item.trim();
        return (
          <button
            key={item}
            type="button"
            onClick={() => onPick(item)}
            className={cx(
              "max-w-64 truncate rounded-ctl border px-2 py-0.5 text-xs transition-colors",
              active
                ? "border-line-strong bg-raised text-ink"
                : "border-line bg-surface text-ink-3 hover:border-line-strong hover:text-ink",
              mono && "num",
            )}
            title={item}
          >
            {item.replace(/^https?:\/\//, "")}
          </button>
        );
      })}
      {hasInput && onClear && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 rounded-ctl px-1.5 py-0.5 text-xs text-ink-3 transition-colors hover:bg-raised hover:text-ink"
        >
          <X className="size-3" />
          清空
        </button>
      )}
    </div>
  );
}

/* ---------- Parameters panel ---------- */

/** Marks a setting the MCP tool does not have. */
export function LocalTag() {
  return (
    <Tooltip content="MCP 工具没有这项参数：仅对调试台发起的调用生效，不修改配置。">
      <span className="tag cursor-help rounded-[3px] border border-line px-1 normal-case">仅调试台</span>
    </Tooltip>
  );
}

/** One section of the parameters panel. */
export function OptionGroup({ title, local, action, children }: { title: ReactNode; local?: boolean; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3.5 p-4">
      <header className="flex h-5 items-center gap-2">
        <h3 className="tag truncate">{title}</h3>
        {local && <LocalTag />}
        {action && <span className="ml-auto flex shrink-0 items-center">{action}</span>}
      </header>
      {children}
    </section>
  );
}

/** A labelled control that is not a single form field, so it must not sit in a <label>. */
export function Group({ label, hint, local, children }: { label: ReactNode; hint?: ReactNode; local?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-xs font-medium text-ink-2">
        {label}
        {local && <LocalTag />}
      </span>
      {children}
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </div>
  );
}

/** Puts a parameter back to what the configuration says. */
export function ResetButton({ onClick, label = "恢复配置值" }: { onClick: () => void; label?: string }) {
  return (
    <Button size="sm" variant="ghost" icon={<RotateCcw />} className="-my-1 -mr-2" onClick={onClick}>
      {label}
    </Button>
  );
}

/* ---------- Provider ---------- */

/** Chooses the provider of a call from the composer bar. */
export function ProviderChip({ tool, value, onChange, changed }: { tool: RoutedTool; value: string; onChange: (value: string) => void; changed?: boolean }) {
  const { provider } = useConfig();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-84 p-2"
      trigger={<Chip icon={<Boxes />} label="提供商" value={value === "auto" ? "自动" : provider(value).name} changed={changed || value !== "auto"} />}
    >
      <ProviderPicker
        tool={tool}
        value={value}
        onChange={(next) => {
          onChange(next);
          setOpen(false);
        }}
      />
      <p className="px-1 pt-2 pb-0.5 text-xs text-ink-3">「自动」按路由顺序尝试并在失败时切换；固定一个提供商后，可在「参数」中临时调整它的参数。</p>
    </Popover>
  );
}

/** JSON with its keys in order, so two objects with the same content compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

const shape = (p: RouteParams) => stable({ options: p.options ?? {}, extra_body: p.extra_body ?? {} });

export interface Tuning {
  /** The parameters the pinned provider runs with: the tuned ones, or else the configured ones. */
  value: RouteParams;
  /** Whether they differ from the configuration. */
  changed: boolean;
  /** What to send with the call; undefined while nothing differs. */
  route: RouteTuning | undefined;
  set: (value: RouteParams) => void;
  reset: () => void;
  /** Changes whenever the fields must be rebuilt from `value`. */
  version: string;
}

/**
 * The parameters of the pinned provider as tuned for the playground. Each
 * provider keeps its own, so switching between them loses nothing.
 */
export function useTuning(tool: RoutedTool, engine: string): Tuning {
  const { config } = useConfig();
  const [tuned, setTuned] = useState<Record<string, RouteParams>>({});
  const [resets, setResets] = useState(0);
  const saved = config[tool].routes.find((r) => r.provider === engine);
  const base: RouteParams = { options: saved?.options, extra_body: saved?.extra_body };
  const own = engine === "auto" ? undefined : tuned[engine];
  const changed = own !== undefined && shape(own) !== shape(base);
  return {
    value: own ?? base,
    changed,
    route: changed ? { provider: engine, options: own.options, extra_body: own.extra_body } : undefined,
    set: (value) => setTuned((all) => ({ ...all, [engine]: value })),
    reset: () => {
      setTuned(({ [engine]: _, ...rest }) => rest);
      setResets((n) => n + 1);
    },
    version: `${engine}:${resets}`,
  };
}

/**
 * Tunes the pinned provider for one call. When `engine === "auto"`, renders a
 * compact footer bar instead of taking up a whole empty column.
 */
export function ProviderParams({ tool, engine, tuning, note }: { tool: RoutedTool; engine: string; tuning: Tuning; note?: ReactNode }) {
  const { provider } = useConfig();
  const page = toolPage(tool);
  if (engine === "auto") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 bg-sunken/35 px-4 py-2.5 text-xs text-ink-3">
        <span>
          当前提供商为「自动」，各提供商使用{" "}
          <Link href={page} className="text-ink-2 underline underline-offset-2 hover:text-ink">
            已保存的路由参数
          </Link>
          。在顶栏固定某一提供商后，可在此临时微调其专有参数。
        </span>
        <LocalTag />
      </div>
    );
  }
  return (
    <OptionGroup title={`${provider(engine).name} 专有参数`} local action={tuning.changed && <ResetButton onClick={tuning.reset} />}>
      <OptionFields key={tuning.version} tool={tool} provider={engine} value={tuning.value} onChange={tuning.set} columns="@lg:grid-cols-2 @4xl:grid-cols-3" />
      <p className="text-xs text-ink-3">
        {tuning.changed ? "已自定义参数，" : "初始值取自配置，"}改动只随调试台的调用发出。{note} 要让 MCP 调用也生效，请到{" "}
        <Link href={page} className="text-ink-2 underline underline-offset-2 hover:text-ink">
          路由页
        </Link>{" "}
        保存。
      </p>
    </OptionGroup>
  );
}

/* ---------- Output ---------- */

export type RunView = "result" | "flow" | "timeline";

/** What the output pane needs of a call made here; `usePlay` returns it. */
export interface RunState {
  pending: boolean;
  nodes: TraceNode[];
  text: TraceText;
  /** When the call was made; 0 before the first. */
  submittedAt: number;
  callId?: string;
  data?: { call_id?: string };
}

/**
 * Which view of the output is on show. A call opens on its flow, which is
 * what moves while it runs, and turns to its result when it ends, unless the
 * view was changed by hand meanwhile.
 */
export function useRunView(pending: boolean) {
  const [view, setView] = useState<RunView>("result");
  const touched = useRef(false);
  const was = useRef(pending);
  useEffect(() => {
    if (was.current && !pending && !touched.current) setView("result");
    was.current = pending;
  }, [pending]);
  return {
    view,
    /** A tab picked by hand. */
    pick: (next: RunView) => {
      touched.current = true;
      setView(next);
    },
    /** A call has been made. */
    begin: () => {
      touched.current = false;
      setView("flow");
    },
    show: setView,
  };
}

/** What a call in flight is doing, and for how long it has been going. */
function Progress({ nodes, since }: { nodes: TraceNode[]; since: number }) {
  const now = useNow(true, 100);
  const active = useMemo(() => activeOf(nodes), [nodes]);
  return (
    <div className="flex items-center gap-2.5 border-b border-line bg-sunken/25 px-4 py-2 text-xs text-ink-2">
      <Dot tone="signal" live />
      <LivePhase call={{ active }} className="inline-flex min-w-0 flex-1 items-center gap-1.5" />
      <span className="num shrink-0 text-ink">{duration(Math.max(0, now - since))}</span>
    </div>
  );
}

/**
 * The pane a call answers into. It is always there: before the first call it
 * says what will appear; while a call runs it draws the call's flow as the
 * gateway reports it; afterwards it holds the result, the flow and the time
 * axis of that call, or of a past one picked from the recent runs.
 */
export function Output({
  run,
  inspected,
  view,
  onView,
  actions,
  strip,
  banner,
  hint,
  children,
}: {
  run: RunState;
  inspected: InspectedRun | null;
  view: RunView;
  onView: (view: RunView) => void;
  /** Controls of the result view, at the right end of the tabs. */
  actions?: ReactNode;
  /** The key facts of a finished call. */
  strip?: ReactNode;
  /** Shown above the tabs, as when a past run is on show. */
  banner?: ReactNode;
  /** What a call of this tool answers with, said before the first one. */
  hint: ReactNode;
  /** The result view, once there is a call. */
  children: ReactNode;
}) {
  const entry = inspected?.entry;
  const nodes = useMemo(() => (entry ? (entry.trace?.length ? entry.trace : legacyTrace(entry)) : run.nodes), [entry, run.nodes]);
  const live = !entry && run.pending;
  const idle = !entry && !run.pending && run.submittedAt === 0;
  const stamp = entry ? entry.id : run.submittedAt;
  const record = entry ? String(entry.id) : (run.data?.call_id ?? run.callId);
  // A provider that failed or was passed over is worth a look, even when the call went well.
  const troubled = nodes.some((n) => (n.kind === "attempt" || n.kind === "llm") && (n.status === "error" || n.status === "skipped" || n.status === "limited"));
  const streamingResult = live && Object.keys(run.text).length > 0;
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    setSelected(0);
  }, [stamp]);
  const selectNode = (id: number) => {
    setSelected(id);
    if (id !== 0) onView(view);
  };

  // The pane sits below the composer, where a new call could go unseen.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!stamp || !node) return;
    if (node.getBoundingClientRect().top > window.innerHeight * 0.6) node.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [stamp]);

  return (
    // No overflow clipping here: it would stop a sticky footer from sticking to the viewport.
    <section ref={ref} className="flex min-h-[26rem] min-w-0 scroll-mt-6 flex-col rounded-panel border border-line bg-surface">
      {banner && <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-panel border-b border-line bg-raised/60 px-4 py-2 text-xs">{banner}</div>}
      <Tabs value={view} onChange={onView} className="flex-1">
        <TabList
          tabs={[
            {
              value: "result",
              label: (
                <>
                  结果
                  {streamingResult && <Dot tone="signal" live />}
                </>
              ),
            },
            {
              value: "flow",
              label: (
                <>
                  流程
                  {live ? <Dot tone="signal" live /> : troubled ? <Dot tone="warn" /> : null}
                </>
              ),
            },
            { value: "timeline", label: "时间轴" },
          ]}
          actions={
            <>
              {actions}
              {record && !live && (
                <Tooltip content="在请求日志里打开这次调用的完整记录">
                  <Link href={`/logs/${record}`} className="grid size-7 place-items-center rounded-ctl text-ink-3 transition-colors hover:bg-raised hover:text-ink" aria-label="完整记录">
                    <ScrollText className="size-3.5" />
                  </Link>
                </Tooltip>
              )}
            </>
          }
        />
        {live ? (
          <Progress nodes={nodes} since={run.submittedAt} />
        ) : (
          strip && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-sunken/25 px-4 py-2 text-xs text-ink-3">{strip}</div>
        )}
        <TabPanel value="result" className="flex flex-col">
          {idle ? (
            <div className="grid flex-1 place-items-center">
              <Empty icon={<CornerDownLeft />} title="结果会出现在这里">
                {hint}
              </Empty>
            </div>
          ) : (
            children
          )}
        </TabPanel>
        <TabPanel value="flow" className="flex flex-col">
          {idle ? (
            <div className="grid flex-1 place-items-center">
              <Empty icon={<Workflow />} title="这里会画出调用的流程">
                从入口到返回：缓存命中没有、路由怎么选、请求了哪些提供商、谁被跳过、模型带什么参数、各用了多久。运行时它是活的。
              </Empty>
            </div>
          ) : nodes.length === 0 ? (
            <div className="grid flex-1 place-items-center py-16">{live ? <Spinner /> : <span className="text-xs text-ink-3">这次调用没有留下流程。</span>}</div>
          ) : (
            <>
              {entry && !entry.trace?.length && <div className="border-b border-line px-4 py-2 text-xs text-ink-3">这条记录来自升级之前：只记下了请求过哪些上游，没有记下判断过程。</div>}
              <FlowView
                key={stamp}
                nodes={nodes}
                text={entry ? undefined : run.text}
                live={live}
                origin={run.submittedAt}
                selected={selected}
                onSelect={selectNode}
                className="flex-1 overflow-hidden rounded-b-panel"
              />
            </>
          )}
        </TabPanel>
        <TabPanel value="timeline" className="flex flex-col">
          {nodes.length === 0 ? (
            <div className="grid place-items-center px-6 py-16 text-center text-xs text-ink-3">{idle ? "运行后，这里按时间轴排出这次调用里每一段耗时。" : "这次调用没有留下流程。"}</div>
          ) : (
            <TimelineView
              key={stamp}
              nodes={nodes}
              text={entry ? undefined : run.text}
              live={live}
              origin={run.submittedAt}
              selected={selected}
              onSelect={selectNode}
              className="flex-1 overflow-hidden rounded-b-panel"
            />
          )}
        </TabPanel>
      </Tabs>
    </section>
  );
}

export { TabPanel };

export function Waiting({ label, elapsed }: { label: ReactNode; elapsed: number }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-sm text-ink-2">
      <Spinner />
      <span className="max-w-md truncate text-center">{label}</span>
      <span className="num text-xs text-ink-3">{duration(elapsed)}</span>
    </div>
  );
}

/** The text a model has written last, of all the models of a call. */
export function latestText(text: TraceText): string {
  const ids = Object.keys(text).map(Number);
  return ids.length ? text[Math.max(...ids)] : "";
}

/**
 * An answer while its model writes it. The model quotes the page by line
 * numbers, which the gateway replaces with the lines once it is done; until
 * then the quote is named.
 */
export function Writing({ text }: { text: string }) {
  const shown = text.replace(/<copy lines="(\d+)-(\d+)"\s*\/>/g, "\n> 原文第 $1–$2 行\n").replace(/<[^>\n]*$/, "");
  return (
    <article className="flex-1 px-5 py-4">
      <div className="mb-3 flex items-center gap-2 text-xs text-ink-3">
        <Dot tone="signal" live />
        模型正在写回答
      </div>
      <Markdown>{shown}</Markdown>
    </article>
  );
}

export function Failure({ error }: { error: Error }) {
  // A call stopped here did not fail.
  const stopped = error instanceof APIError && error.status === 499;
  return (
    <div className="p-4">
      {stopped ? <Notice tone="neutral">已停止这次调用。已经发出的上游请求不会撤回，「流程」里能看到它停在哪一步。</Notice> : <Notice tone="err">{error.message}</Notice>}
    </div>
  );
}

/** What a result says went wrong; a call stopped from here or the logs did not fail. */
export function ResultError({ error, children }: { error: string; children?: ReactNode }) {
  if (error === stoppedHere) return <Notice tone="neutral">{children}已停止这次调用，没有拿到结果。</Notice>;
  return (
    <Notice tone="err">
      {children}
      {error}
    </Notice>
  );
}

export function JSONView({ value, label = "MCP 工具返回给 Agent 的原始内容" }: { value: unknown; label?: string }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-xs text-ink-3">{label}</p>
      <CodeBlock copy wrap>
        {JSON.stringify(value, null, 2)}
      </CodeBlock>
    </div>
  );
}

/**
 * Fallback view when inspecting a historical run whose response body was not
 * persisted (`logs.capture_body` was off at the time).
 */
export function HistoricalFallback({
  entry,
  request,
  onRerun,
}: {
  entry: LogEntry;
  request: Record<string, unknown> | null;
  onRerun: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      {entry.error === stoppedHere ? (
        <Notice tone="neutral">这次调用被从控制台中止。「流程」里能看到它停在哪一步。</Notice>
      ) : entry.error ? (
        <Notice tone="err">{entry.error}</Notice>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-ctl border border-line bg-sunken/50 px-3.5 py-2.5 text-xs text-ink-2">
          <span>
            该次历史运行未记录返回正文（可在{" "}
            <Link href="/system" className="text-ink underline underline-offset-2 hover:text-signal-text">
              系统设置
            </Link>{" "}
            中开启「记录返回内容」）。可载入当时参数重新运行，或切换至「流程」查看当时怎么走的。
          </span>
          <Button size="sm" variant="secondary" icon={<Play />} onClick={onRerun}>
            以此参数重新运行
          </Button>
        </div>
      )}
      {request && (
        <div>
          <div className="tag mb-1.5">当时的请求参数</div>
          <CodeBlock copy>{JSON.stringify(request, null, 2)}</CodeBlock>
        </div>
      )}
    </div>
  );
}

/** Banner rendered at the top of Output when viewing a past LogEntry. */
export function HistoryBanner({
  entry,
  onRestore,
  onRerun,
  onClose,
}: {
  entry: LogEntry;
  onRestore?: () => void;
  onRerun: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <History className="size-3.5 shrink-0 text-ink-3" />
        <span className="text-ink-2">历史记录</span>
        <span className="num text-ink">#{entry.id}</span>
        <RunStatus entry={entry} />
        <span className="num text-ink-3" title={dateTime(entry.ts)}>
          · {ago(entry.ts)}
        </span>
        {entry.source === "mcp" && <Badge>{entry.api_key_name || "MCP"}</Badge>}
      </div>
      <div className="flex items-center gap-1.5">
        {onRestore && (
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={onRestore}>
            载入参数
          </Button>
        )}
        <Button size="sm" variant="secondary" icon={<Play />} onClick={onRerun}>
          重新运行
        </Button>
        <Button size="sm" variant="ghost" icon={<X />} aria-label="关闭历史详情" onClick={onClose} />
      </div>
    </>
  );
}

/* ---------- Code ---------- */

/** Shows the call as the request an MCP client sends for it. */
export function CodeButton({ tool, args, notices }: { tool: string; args: object; notices?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, null, 2);
  return (
    <>
      <Button size="sm" variant="ghost" icon={<Code />} onClick={() => setOpen(true)}>
        MCP 请求
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        width="max-w-2xl"
        title="MCP 请求"
        description={
          <>
            MCP 客户端调用 <span className="num text-ink-2">{tool}</span> 工具时发送的请求，取自当前的输入与参数；未列出的参数取默认值。
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {notices}
          <CodeBlock copy>{body}</CodeBlock>
        </div>
      </Dialog>
    </>
  );
}

/** Says which settings of the composer an MCP client cannot send. */
export function LocalNotice({ items }: { items: (string | false | undefined)[] }) {
  const list = items.filter(Boolean);
  if (list.length === 0) return null;
  return <Notice tone="info">以下设置仅在调试台生效，MCP 调用无法携带，Agent 始终使用已保存的配置：{list.join("；")}。</Notice>;
}

/* ---------- Recent runs ---------- */

export interface InspectedRun<R = unknown> {
  entry: LogEntry;
  request: Record<string, unknown> | null;
  response: R | null;
}

export function parseJSON<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** How a past run ended, as a dot and a word. */
function RunStatus({ entry }: { entry: LogEntry }) {
  const stopped = entry.error === stoppedHere;
  return (
    <span className={cx("inline-flex items-center gap-1.5", stopped ? "text-ink-3" : entry.status === "ok" ? "text-ok" : "text-err")}>
      <Dot tone={stopped ? "neutral" : entry.status === "ok" ? "ok" : "err"} />
      {stopped ? "已中止" : entry.status === "ok" ? "成功" : "失败"}
    </span>
  );
}

/**
 * The latest calls of a tool, in a drawer the head of the page opens.
 * Clicking a row loads the full log entry (its request, its flow, and its
 * response if captured) into the output pane; the button of a row takes its
 * arguments back into the composer.
 */
export function Recent<R = unknown>({
  tool,
  stamp,
  activeId,
  onPick,
  onInspect,
}: {
  tool: RoutedTool;
  /** Changes when a call has finished. */
  stamp: unknown;
  /** ID of the currently inspected log entry, if any. */
  activeId?: number | null;
  onPick: (request: Record<string, unknown>) => void;
  onInspect?: (inspected: InspectedRun<R>) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"webui" | "all">("all");
  const recent = useQuery({
    queryKey: ["play-recent", tool, scope],
    queryFn: () => api.logs({ tool, source: scope === "webui" ? "webui" : undefined, limit: 30 }),
  });
  const { refetch } = recent;
  useEffect(() => {
    if (stamp === undefined) return;
    // The request log is written a moment after the call returns.
    const timer = setTimeout(() => void refetch(), 650);
    return () => clearTimeout(timer);
  }, [stamp, refetch]);

  const select = async (entry: LogEntry, loadFormOnly = false) => {
    try {
      const full = await api.log(entry.id);
      const req = parseJSON<Record<string, unknown>>(full.request);
      const res = parseJSON<R>(full.response);
      if (loadFormOnly) {
        if (!req || typeof req !== "object") throw new Error();
        onPick(req);
      } else if (onInspect) {
        onInspect({ entry: full, request: req, response: res });
      } else if (req && typeof req === "object") {
        onPick(req);
      }
      setOpen(false);
    } catch {
      toast("无法读取这次调用的记录：记录已被清理，或请求参数被截断。", "err");
    }
  };

  const entries = recent.data ?? [];
  return (
    <>
      <Drawer
        trigger={<Button icon={<History />}>历史</Button>}
        open={open}
        onOpenChange={setOpen}
        width="w-[min(28rem,100vw)]"
        bodyClassName=""
        title="最近运行"
        description="点一条，在下方看它的结果和流程；↻ 只把参数载入输入框。"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-overlay px-4 py-2">
          <Segmented
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "全部来源" },
              { value: "webui", label: "仅调试台" },
            ]}
          />
          <Link href={`/logs?tool=${tool}`} className="text-xs text-ink-3 transition-colors hover:text-ink">
            全部日志 →
          </Link>
        </div>
        {entries.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-ink-3">
            {recent.isPending ? "正在读取…" : scope === "webui" ? "调试台还没有运行过这个工具。" : "这个工具还没有被调用过。"}
          </div>
        ) : (
          <ol className="divide-y divide-line">
            {entries.map((entry) => {
              const active = activeId === entry.id;
              const stopped = entry.error === stoppedHere;
              return (
                <li key={entry.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-current={active ? "true" : undefined}
                    onClick={() => void select(entry)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void select(entry);
                      }
                    }}
                    className={cx("relative flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised/60", active && "bg-raised")}
                  >
                    {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-signal-text" />}
                    <Dot tone={stopped ? "neutral" : entry.status === "ok" ? "ok" : "err"} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink">{entry.summary || "—"}</div>
                      <div className="num mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
                        <span>#{entry.id}</span>
                        <span>{duration(entry.duration_ms)}</span>
                        <span title={dateTime(entry.ts)}>{ago(entry.ts)}</span>
                        {entry.input_tokens + entry.output_tokens > 0 && <span>{compact(entry.input_tokens + entry.output_tokens)} tok</span>}
                        {entry.hops && entry.hops.length > 0 && <span className="text-warn">回退</span>}
                        {entry.source === "mcp" && <span className="font-sans">{entry.api_key_name || "MCP"}</span>}
                      </div>
                      {stopped ? (
                        <div className="mt-0.5 text-xs text-ink-3">从控制台中止</div>
                      ) : (
                        entry.error && <div className="mt-0.5 truncate text-xs text-err">{entry.error}</div>
                      )}
                    </div>
                    <Tooltip content="只载入参数">
                      <button
                        type="button"
                        aria-label="载入这次调用的参数"
                        onKeyDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          void select(entry, true);
                        }}
                        className="-mr-1.5 grid size-7 shrink-0 place-items-center rounded-ctl text-ink-3 transition-colors hover:bg-surface hover:text-ink"
                      >
                        <RotateCcw className="size-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Drawer>
    </>
  );
}

/* ---------- Result rows ---------- */

export function host(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Reads a list of words from a logged request. */
export const words = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
