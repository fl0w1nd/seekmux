import { useQuery } from "@tanstack/react-query";
import { Boxes, Code, CornerDownLeft, History, Play, RotateCcw, Sparkles, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { ProviderNames } from "../../components/ProviderName";
import { ProviderPicker } from "../../components/ProviderPicker";
import { OptionFields, type RouteParams } from "../../components/RouteOptions";
import { Waterfall } from "../../components/Waterfall";
import { api, type Attempt, type LogEntry, type RoutedTool, type RouteTuning } from "../../lib/api";
import { useConfig } from "../../lib/config";
import { ago, compact, dateTime, duration, toolPage } from "../../lib/format";
import { Dialog, Popover, useToast } from "../../ui/overlays";
import { Badge, Button, CodeBlock, cx, Dot, Empty, Notice, Panel, Segmented, Spinner, TabList, TabPanel, Tabs, Tooltip } from "../../ui/primitives";

const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/* ---------- Stage ---------- */

/**
 * The head of a playground page and the workbench stack below it.
 * All sections share the same full container width for visual alignment.
 */
export function Stage({
  tool,
  title,
  description,
  actions,
  children,
}: {
  tool?: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="tag text-signal-text">调试台</span>
            {tool && <span className="tag">· {tool}</span>}
          </div>
          <h1 className="mt-0.5 text-xl font-medium tracking-tight">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-3">{description}</p>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/* ---------- Composer ---------- */

/** The style of the main input of a composer, which has no frame of its own. */
export const bare = "block w-full bg-transparent px-4 text-base text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50";

/**
 * Structured request workbench:
 * 1. Top instrument bar (`tools` on the left, `toolbarRight` on the right)
 * 2. Collapsible parameter panel (`panel`, smartly 1-col or 2-col based on `splitPanel`)
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
  /** Whether the collapsible parameter panel splits into 2 columns on desktop. */
  splitPanel?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-panel border border-line-strong bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken/45 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{tools}</div>
        {toolbarRight && <div className="ml-auto flex shrink-0 items-center gap-1.5">{toolbarRight}</div>}
      </div>

      {panel !== undefined && (
        <Collapsible.Root open={open}>
          <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-fold-up data-[state=open]:animate-fold-down">
            <div
              className={cx(
                "border-b border-line bg-sunken/20 [&>*]:border-line",
                splitPanel ? "grid max-md:divide-y md:grid-cols-2 md:divide-x" : "flex flex-col divide-y",
              )}
            >
              {panel}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      )}

      <div className="bg-surface">{children}</div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-sunken/25 px-3.5 py-2">
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

export function RunButton({ label, loading, disabled, onClick }: { label: string; loading: boolean; disabled: boolean; onClick: () => void }) {
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

/** Ready-made inputs inside the composer footer bar; stays available so switching examples takes one click. */
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
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="tag flex items-center gap-1 text-ink-3">
        <Sparkles className="size-3" />
        示例
      </span>
      {items.map((item) => {
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
      <OptionFields key={tuning.version} tool={tool} provider={engine} value={tuning.value} onChange={tuning.set} columns="sm:grid-cols-2" />
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

/** The pane a call answers into: tabs of its views, and a strip of its key facts. */
export function Output<T extends string>({
  view,
  onView,
  tabs,
  actions,
  strip,
  banner,
  stamp,
  children,
}: {
  view: T;
  onView: (view: T) => void;
  tabs: { value: T; label: ReactNode }[];
  actions?: ReactNode;
  strip?: ReactNode;
  /** Optional top banner (e.g. when inspecting a historical run). */
  banner?: ReactNode;
  /** Changes with every call, which brings the pane into view: an open parameter panel pushes it below the fold. */
  stamp?: unknown;
  /** One TabPanel per tab. */
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!stamp || !node) return;
    if (node.getBoundingClientRect().top > window.innerHeight * 0.6) node.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [stamp]);
  return (
    // No overflow clipping here: it would stop a sticky footer from sticking to the viewport.
    <section ref={ref} className="min-w-0 scroll-mt-6 rounded-panel border border-line bg-surface">
      {banner && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-raised/60 px-4 py-2 text-xs">{banner}</div>}
      <Tabs value={view} onChange={onView}>
        <TabList tabs={tabs} actions={actions} />
        {strip && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-sunken/25 px-4 py-2 text-xs text-ink-3">{strip}</div>}
        {children}
      </Tabs>
    </section>
  );
}

export { TabPanel };

export function Waiting({ label, elapsed }: { label: ReactNode; elapsed: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-sm text-ink-2">
      <Spinner />
      <span className="max-w-md truncate text-center">{label}</span>
      <span className="num text-xs text-ink-3">{duration(elapsed)}</span>
    </div>
  );
}

export function Failure({ error }: { error: Error }) {
  return (
    <div className="p-4">
      <Notice tone="err">{error.message}</Notice>
    </div>
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
      {entry.error ? (
        <Notice tone="err">{entry.error}</Notice>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-ctl border border-line bg-sunken/50 px-3.5 py-2.5 text-xs text-ink-2">
          <span>
            该次历史运行未记录返回正文（可在{" "}
            <Link href="/system" className="text-ink underline underline-offset-2 hover:text-signal-text">
              系统设置
            </Link>{" "}
            中开启「记录返回内容」）。当时参数已载入上方输入框，可一键重新运行，或切换至「调用链」查看上游耗时。
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
  onRerun,
  onClose,
}: {
  entry: LogEntry;
  onRerun: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Badge tone={entry.status === "ok" ? "ok" : "err"} dot>
          历史记录 #{entry.id}
        </Badge>
        <span className="num text-ink-2">{dateTime(entry.ts)}</span>
        <span className="text-ink-3">({ago(entry.ts)})</span>
        {entry.source === "mcp" && <Badge>{entry.api_key_name || "MCP"}</Badge>}
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="secondary" icon={<Play />} onClick={onRerun}>
          重新运行
        </Button>
        <Button size="sm" variant="ghost" icon={<X />} aria-label="关闭历史详情" onClick={onClose} />
      </div>
    </>
  );
}

/* ---------- Upstream calls ---------- */

const count = (attempts: Attempt[], ...statuses: Attempt["status"][]) => attempts.filter((a) => statuses.includes(a.status)).length;

/** The label of the tab that shows the upstream calls; a dot marks attempts that did not serve the call. */
export function traceLabel(attempts: Attempt[] | null | undefined): ReactNode {
  return (
    <>
      调用链
      {attempts && attempts.length > 0 && <span className="num text-xs text-ink-3">{attempts.length}</span>}
      {/* A canceled attempt lost a race, which is normal. */}
      {attempts && count(attempts, "error", "skipped", "limited") > 0 && <Dot tone="warn" />}
    </>
  );
}

export function TraceView({ attempts, total }: { attempts: Attempt[] | null | undefined; total: number }) {
  if (attempts === undefined) return <Empty title="运行后，此处按时间轴显示本次调用的上游请求" />;
  if (!attempts || attempts.length === 0) return <div className="p-4 text-xs text-ink-3">本次调用未请求任何上游提供商</div>;
  // A provider that was passed over, or a cache hit, is a note and not a call.
  const failed = count(attempts, "error");
  const skipped = count(attempts, "skipped", "limited");
  const cached = count(attempts, "cached");
  const calls = attempts.length - skipped - cached;
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-xs text-ink-3">
        上游调用 {calls} 次{failed > 0 && `，失败 ${failed} 次`}
        {skipped > 0 && `；因熔断或限流跳过 ${skipped} 次`}
        {cached > 0 && `；缓存命中 ${cached} 次`}。完整记录见{" "}
        <Link href="/logs" className="text-ink-2 underline underline-offset-2 hover:text-ink">
          请求日志
        </Link>
        。
      </p>
      <Waterfall attempts={attempts} total={total} />
    </div>
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

/**
 * The latest calls of a tool. Clicking a row loads the full log entry (request,
 * upstream attempts waterfall, and response if captured) into the playground
 * output pane AND populates the composer parameters.
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
  const [scope, setScope] = useState<"webui" | "all">("all");
  const recent = useQuery({
    queryKey: ["play-recent", tool, scope],
    queryFn: () => api.logs({ tool, source: scope === "webui" ? "webui" : undefined, limit: 8 }),
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
      if (req && typeof req === "object") {
        onPick(req);
      } else if (loadFormOnly) {
        throw new Error();
      }
      if (!loadFormOnly && onInspect) {
        onInspect({ entry: full, request: req, response: res });
      }
    } catch {
      toast("无法读取这次调用的记录：记录已被清理，或请求参数被截断。", "err");
    }
  };

  const entries = recent.data ?? [];
  return (
    <Panel
      flush
      title={
        <span className="flex items-center gap-2 self-center">
          <History className="size-4 text-ink-3" />
          <span>最近运行</span>
          {entries.length > 0 && <Badge>{entries.length}</Badge>}
        </span>
      }
      actions={
        <>
          <Segmented
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "全部来源" },
              { value: "webui", label: "仅调试台" },
            ]}
          />
          <Link href={`/logs?tool=${tool}`} className="ml-1 text-xs text-ink-3 transition-colors hover:text-ink">
            全部日志 →
          </Link>
        </>
      }
    >
      {entries.length === 0 ? (
        <div className="flex items-center justify-between gap-4 px-4 py-5 text-xs text-ink-3">
          <span>
            {recent.isPending
              ? "正在读取最近运行记录…"
              : scope === "webui"
                ? "尚无调试台运行记录。从上方发起调用后，可在此回看结果、调用链或复现参数。"
                : "尚无该工具的运行记录。从上方发起一次调用后，记录将显示在此处。"}
          </span>
        </div>
      ) : (
        <ol className="divide-y divide-line">
          {entries.map((entry) => {
            const active = activeId === entry.id;
            const tokens = entry.input_tokens + entry.output_tokens;
            const hasFallback = Boolean(entry.hops && entry.hops.length > 0);
            return (
              <li key={entry.id}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-current={active ? "true" : undefined}
                  onClick={() => void select(entry, false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void select(entry, false);
                    }
                  }}
                  className={cx(
                    "group relative flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-raised/60",
                    active && "bg-raised",
                  )}
                >
                  {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-signal-text" />}
                  <Dot tone={entry.status === "ok" ? "ok" : "err"} />
                  <span className="num w-12 shrink-0 text-xs text-ink-3">#{entry.id}</span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-ink">{entry.summary || "—"}</span>
                      {entry.source === "mcp" && <Badge className="max-sm:hidden">{entry.api_key_name || "MCP"}</Badge>}
                      {hasFallback && (
                        <Badge tone="warn" className="max-sm:hidden">
                          回退
                        </Badge>
                      )}
                    </div>
                    {entry.error && <div className="mt-0.5 truncate text-xs text-err">{entry.error}</div>}
                  </div>

                  {entry.provider && (
                    <span className="shrink-0 text-xs text-ink-2 max-md:hidden">
                      <ProviderNames ids={entry.provider} />
                    </span>
                  )}

                  {tokens > 0 && <span className="num shrink-0 text-xs text-ink-3 max-lg:hidden">{compact(tokens)} tok</span>}

                  <span className="num w-14 shrink-0 text-right text-xs text-ink-2">{duration(entry.duration_ms)}</span>
                  <span className="w-16 shrink-0 text-right text-xs text-ink-3 max-sm:hidden">{ago(entry.ts)}</span>

                  <Tooltip content="仅载入参数到输入框">
                    <button
                      type="button"
                      aria-label="载入这次调用的参数"
                      onClick={(e) => {
                        e.stopPropagation();
                        void select(entry, true);
                      }}
                      className="grid size-7 shrink-0 place-items-center rounded-ctl text-ink-3 transition-colors hover:bg-surface hover:text-ink"
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
    </Panel>
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
