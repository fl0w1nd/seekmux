import { useQuery } from "@tanstack/react-query";
import { Boxes, Code, CornerDownLeft, Play, RotateCcw } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { ProviderPicker } from "../../components/ProviderPicker";
import { OptionFields, type RouteParams } from "../../components/RouteOptions";
import { Waterfall } from "../../components/Waterfall";
import { api, type Attempt, type LogEntry, type RoutedTool, type RouteTuning } from "../../lib/api";
import { useConfig } from "../../lib/config";
import { ago, duration } from "../../lib/format";
import { Dialog, Popover, useToast } from "../../ui/overlays";
import { Button, CodeBlock, cx, Dot, Empty, Notice, Spinner, TabList, TabPanel, Tabs, Tooltip } from "../../ui/primitives";

const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/* ---------- Stage ---------- */

function Cross({ className }: { className: string }) {
  return (
    <span aria-hidden className={cx("absolute size-2.5 -translate-x-1/2 -translate-y-1/2 text-ink-3 max-md:hidden", className)}>
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current" />
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-current" />
    </span>
  );
}

/**
 * The head of a playground page and the stage its composer stands on: a
 * column marked out by hairlines, the way a drawing sheet marks its frame.
 */
export function Stage({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="mb-5">
        <div className="tag text-signal-text">调试台</div>
        <h1 className="mt-0.5 text-xl font-medium tracking-tight">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-3">{description}</p>
      </header>
      <div className="relative py-8 max-md:py-0">
        <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-line-strong to-transparent max-md:hidden" />
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-line-strong to-transparent max-md:hidden" />
        <div className="relative mx-auto max-w-3xl">
          <span aria-hidden className="absolute -inset-y-14 -left-8 w-px bg-linear-to-b from-transparent via-line-strong to-transparent max-md:hidden" />
          <span aria-hidden className="absolute -inset-y-14 -right-8 w-px bg-linear-to-b from-transparent via-line-strong to-transparent max-md:hidden" />
          <Cross className="-top-8 -left-8" />
          <Cross className="-top-8 left-[calc(100%+2rem)]" />
          <Cross className="top-[calc(100%+2rem)] -left-8" />
          <Cross className="top-[calc(100%+2rem)] left-[calc(100%+2rem)]" />
          {children}
        </div>
      </div>
    </>
  );
}

/* ---------- Composer ---------- */

/** The style of the main input of a composer, which has no frame of its own. */
export const bare = "block w-full bg-transparent px-4 text-base text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50";

/**
 * What a call is made from: the main input, a bar of the choices that shape
 * the call, and a panel of the rest of its parameters that folds open.
 */
export function Composer({
  children,
  tools,
  actions,
  panel,
  open,
}: {
  children: ReactNode;
  /** The left of the bar: what the call runs with. */
  tools: ReactNode;
  /** The right of the bar, ending in the run button. */
  actions: ReactNode;
  panel: ReactNode;
  open: boolean;
}) {
  return (
    <div className="rounded-panel border border-line-strong bg-surface">
      {children}
      <div className="flex items-center gap-2 border-t border-line p-2.5 max-lg:flex-wrap">
        {/* The summary gives way first, so the bar stays one line for as long as its chips fit. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 max-lg:w-full max-lg:flex-none max-lg:flex-wrap">{tools}</div>
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      <Collapsible.Root open={open}>
        <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-fold-up data-[state=open]:animate-fold-down">
          <div className="grid border-t border-line max-md:divide-y md:grid-cols-2 md:divide-x [&>*]:border-line">{panel}</div>
        </Collapsible.Content>
      </Collapsible.Root>
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
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> & { icon?: ReactNode; label?: ReactNode; value?: ReactNode; /** Marks a value that is not the configured one. */ changed?: boolean }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-8 max-w-64 shrink-0 items-center gap-1.5 rounded-ctl border border-line px-2.5 text-sm text-ink-2 transition-colors",
        "hover:border-line-strong hover:text-ink aria-expanded:border-line-strong aria-expanded:bg-raised aria-expanded:text-ink",
        "aria-pressed:border-line-strong aria-pressed:bg-raised aria-pressed:text-ink [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ink-3",
        className,
      )}
      {...rest}
    >
      {icon}
      {label && <span className={value !== undefined ? "text-ink-3" : undefined}>{label}</span>}
      {value !== undefined && <span className="truncate text-ink">{value}</span>}
      {changed && <Dot tone="signal" />}
    </button>
  );
}

/** The values of the parameters panel in a few words; a click opens the panel. */
export function Summary({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="num min-w-0 truncate px-1 text-xs text-ink-3 transition-colors hover:text-ink">
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

/** Ready-made inputs to start from, under the composer. */
export function Examples({ items, mono = true, onPick }: { items: string[]; mono?: boolean; onPick: (item: string) => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="tag">示例</span>
      {items.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onPick(item)}
          className={cx("max-w-full truncate rounded-ctl border border-line px-2 py-0.5 text-xs text-ink-3 transition-colors hover:border-line-strong hover:text-ink", mono && "num")}
        >
          {item}
        </button>
      ))}
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

/** One column of the parameters panel. */
export function OptionGroup({ title, local, action, children }: { title: ReactNode; local?: boolean; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-4 p-4">
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
      trigger={<Chip icon={<Boxes />} label="提供商" value={value === "auto" ? "自动" : provider(value).name} changed={changed} />}
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

/** The column of the parameters panel that tunes the pinned provider for one call. */
export function ProviderParams({ tool, engine, tuning, note }: { tool: RoutedTool; engine: string; tuning: Tuning; note?: ReactNode }) {
  const { provider } = useConfig();
  const page = tool === "dev_search" ? "/dev-search" : `/${tool}`;
  if (engine === "auto") {
    return (
      <OptionGroup title="提供商参数" local>
        <p className="text-xs text-ink-3">
          当前为「自动」：各提供商使用各自{" "}
          <Link href={page} className="text-ink-2 underline underline-offset-2 hover:text-ink">
            已保存的参数
          </Link>
          。在上方固定一个提供商后，可在此临时调整它的参数再试，无需改动配置。
        </p>
      </OptionGroup>
    );
  }
  return (
    <OptionGroup title={`${provider(engine).name} 的参数`} local action={tuning.changed && <ResetButton onClick={tuning.reset} />}>
      <OptionFields key={tuning.version} tool={tool} provider={engine} value={tuning.value} onChange={tuning.set} columns="sm:grid-cols-2" />
      <p className="text-xs text-ink-3">
        {tuning.changed ? "已偏离配置，" : "初始值取自配置，"}改动只随调试台的调用发出。{note} 要让 MCP 调用也生效，请到{" "}
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
  stamp,
  children,
}: {
  view: T;
  onView: (view: T) => void;
  tabs: { value: T; label: ReactNode }[];
  actions?: ReactNode;
  strip?: ReactNode;
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
    <section ref={ref} className="mt-6 min-w-0 scroll-mt-6 rounded-panel border border-line bg-surface">
      <Tabs value={view} onChange={onView}>
        <TabList tabs={tabs} actions={actions} />
        {strip && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 text-xs text-ink-3">{strip}</div>}
        {children}
      </Tabs>
    </section>
  );
}

export { TabPanel };

export function Waiting({ label, elapsed }: { label: ReactNode; elapsed: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-20 text-sm text-ink-2">
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

export function JSONView({ value }: { value: unknown }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-xs text-ink-3">MCP 工具返回给 Agent 的原始内容。</p>
      <CodeBlock copy wrap>
        {JSON.stringify(value, null, 2)}
      </CodeBlock>
    </div>
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
  if (!attempts || attempts.length === 0) return <div className="p-4 text-xs text-ink-3">本次调用未请求任何上游提供商。</div>;
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
      <Button variant="ghost" icon={<Code />} onClick={() => setOpen(true)}>
        代码
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

/**
 * The latest calls of a tool made from the console. A click hands the
 * arguments of that call to `onPick`, to run it again or from there.
 */
export function Recent({ tool, stamp, onPick }: { tool: RoutedTool; /** Changes when a call has finished. */ stamp: unknown; onPick: (request: Record<string, unknown>) => void }) {
  const toast = useToast();
  const recent = useQuery({ queryKey: ["play-recent", tool], queryFn: () => api.logs({ tool, source: "webui", limit: 6 }) });
  const { refetch } = recent;
  useEffect(() => {
    if (stamp === undefined) return;
    // The request log is written a moment after the call returns.
    const timer = setTimeout(() => void refetch(), 700);
    return () => clearTimeout(timer);
  }, [stamp, refetch]);

  const pick = async (entry: LogEntry) => {
    try {
      const request: unknown = JSON.parse((await api.log(entry.id)).request ?? "");
      if (!request || typeof request !== "object") throw new Error();
      onPick(request as Record<string, unknown>);
    } catch {
      toast("无法还原这次调用的参数：记录已被清理，或请求过长而被截断。", "err");
    }
  };

  const entries = recent.data ?? [];
  return (
    <section className="mt-6">
      <header className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="tag">最近运行</h2>
        <Link href="/logs" className="text-xs text-ink-3 hover:text-ink">
          全部请求日志
        </Link>
      </header>
      <div className="rounded-panel border border-line bg-surface">
        {entries.length === 0 ? (
          <Empty title={recent.isPending ? "正在读取…" : "还没有运行记录"}>{!recent.isPending && "从上方发起一次调用后，记录会出现在这里；点击记录可载入当时的参数。"}</Empty>
        ) : (
          <ol>
            {entries.map((entry) => (
              <li key={entry.id} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  title="载入这次调用的参数"
                  onClick={() => void pick(entry)}
                  className="group flex h-10 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-raised/60"
                >
                  <Dot tone={entry.status === "ok" ? "ok" : "err"} />
                  <span className="min-w-0 flex-1 truncate text-sm">{entry.summary}</span>
                  <RotateCcw className="size-3.5 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 max-sm:hidden" />
                  {entry.provider && <span className="num max-w-40 truncate text-xs text-ink-2 max-sm:hidden">{entry.provider}</span>}
                  <span className="num w-14 shrink-0 text-right text-xs text-ink-2">{duration(entry.duration_ms)}</span>
                  <span className="w-16 shrink-0 text-right text-xs text-ink-3">{ago(entry.ts)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
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
