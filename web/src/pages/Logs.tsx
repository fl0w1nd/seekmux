import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, Maximize2, Radio, ScrollText, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Link, useSearch } from "wouter";
import { LivePhase } from "../components/flow/LivePhase";
import { stoppedHere } from "../components/flow/wording";
import { fetcherNames, ProviderKind, ProviderName } from "../components/ProviderName";
import { api, type Hop, type LiveCall, type LogEntry, type Meta, type ProviderInfo } from "../lib/api";
import { useConfig } from "../lib/config";
import { compact, dateTime, duration, logTime, toolLabel } from "../lib/format";
import { useNow } from "../lib/motion";
import { useLiveCalls } from "../lib/trace";
import { PageHeader } from "../components/PageHeader";
import { modalOpen, SidePanel, useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, cx, Dot, Empty, iconButton, Input, Kbd, Loading, Panel, Segmented, Select, Status, Table, Td, Th, Tooltip } from "../ui/primitives";
import { CallInspector } from "./Log";

const pageSize = 50;

const shortTime = (ts: number) => dateTime(ts).slice(5, 16);

/** A time range as a chip: the end drops the date when it is the same day. */
function rangeLabel(since: number, until: number): string {
  const from = shortTime(since);
  const to = shortTime(until);
  return from.slice(0, 5) === to.slice(0, 5) ? `${from} – ${to.slice(6)}` : `${from} – ${to}`;
}

const positive = (value: string | null) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const callerName = (entry: LogEntry) => (entry.source === "webui" ? "调试台" : entry.api_key_name || "—");

/** A fetcher in a list of plain labels: its type first, as a call's flow names it. */
function fetcherLabel(meta: Meta, info: ProviderInfo): string {
  const { type, name } = fetcherNames(meta, info);
  return name ? `${type} · ${name}` : type;
}

export function LogsPage() {
  const { config, meta, provider: providerInfo } = useConfig();
  const client = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // The overview links here with filters in the address.
  const address = useSearch();
  const [params] = useState(() => new URLSearchParams(address));
  const opened = useRef(params.get("id") ?? "");
  const [tool, setTool] = useState(params.get("tool") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [provider, setProvider] = useState(params.get("provider") ?? "");
  // "webui" for the playground, or the id of an API key.
  const [caller, setCaller] = useState(params.get("caller") ?? "");
  const [range, setRange] = useState(() => {
    const since = positive(params.get("since"));
    const until = positive(params.get("until"));
    return since && until ? { since, until } : null;
  });
  // The call open in the panel: the id of a log entry, or of a call in flight.
  const [inspect, setInspect] = useState(params.get("id") ?? "");

  useEffect(() => {
    const next = new URLSearchParams(address);
    setInspect(next.get("id") ?? "");
    setTool(next.get("tool") ?? "");
    setStatus(next.get("status") ?? "");
    setProvider(next.get("provider") ?? "");
    setCaller(next.get("caller") ?? "");
    const since = positive(next.get("since"));
    const until = positive(next.get("until"));
    setRange((prev) => (since && until ? (prev?.since === since && prev?.until === until ? prev : { since, until }) : null));
  }, [address]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (tool) next.set("tool", tool);
    if (status) next.set("status", status);
    if (provider) next.set("provider", provider);
    if (caller) next.set("caller", caller);
    if (range) {
      next.set("since", String(range.since));
      next.set("until", String(range.until));
    }
    if (inspect) next.set("id", inspect);
    const qs = next.toString();
    const target = qs ? `/logs?${qs}` : "/logs";
    // Opening the panel is a step Back undoes; going from one call to another is not.
    const opening = inspect !== "" && opened.current === "";
    opened.current = inspect;
    if (`${window.location.pathname}${window.location.search}` === target) return;
    if (opening) window.history.pushState({ panel: true }, "", target);
    else window.history.replaceState(window.history.state, "", target);
  }, [tool, status, provider, caller, range, inspect]);
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  // One call in the panel; with a modifier key on a page beside this one, as a link would.
  const open = (e: MouseEvent | KeyboardEvent, id: number | string) => {
    if (e.metaKey || e.ctrlKey) window.open(`/logs/${id}`, "_blank");
    else setInspect(String(id));
  };
  const close = useCallback(() => {
    if ((window.history.state as { panel?: boolean } | null)?.panel) window.history.back();
    else setInspect("");
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = {
    tool,
    provider,
    q: query,
    ...(status === "fallback" ? { fallback: 1 } : { status }),
    ...(caller === "webui" ? { source: caller } : { key: caller }),
    ...(range ?? {}),
  };
  const filterKey = JSON.stringify(filters);
  const logs = useInfiniteQuery({
    queryKey: ["logs", filters],
    queryFn: ({ pageParam }) => api.logs({ ...filters, before: pageParam, limit: pageSize }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === pageSize ? last[last.length - 1].id : undefined),
  });

  // New entries arrive over SSE; refetching keeps the active filters
  // authoritative. A burst is folded into one refetch a second, since each
  // refetch reloads every page shown. The same stream says which calls are
  // in flight.
  const refetch = useRef<ReturnType<typeof setTimeout>>(undefined);
  const arrived = useCallback(() => {
    refetch.current ??= setTimeout(() => {
      refetch.current = undefined;
      void client.invalidateQueries({ queryKey: ["logs"] });
    }, 1000);
  }, [client]);
  useEffect(() => () => clearTimeout(refetch.current), []);
  const flying = useLiveCalls(live, arrived);

  const entries = logs.data?.pages.flat() ?? [];
  const newest = entries[0]?.id ?? 0;

  // With the panel open, ↑ and ↓ step through the rows behind it.
  const order = useRef<number[]>([]);
  order.current = entries.map((e) => e.id);
  useEffect(() => {
    if (!inspect) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.metaKey || e.ctrlKey || e.altKey || modalOpen()) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const ids = order.current;
      const at = ids.indexOf(Number(inspect));
      const next = at < 0 ? ids[0] : ids[at + (e.key === "ArrowDown" ? 1 : -1)];
      if (next === undefined) return;
      e.preventDefault();
      setInspect(String(next));
      document.querySelector(`[data-log="${next}"]`)?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspect]);

  // Rows that arrived since the last refetch are marked for a moment. A change
  // of filters shows a different list, not new rows.
  const seen = useRef<{ key: string; top: number } | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const top = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  useEffect(() => {
    if (!logs.data) return;
    const before = seen.current;
    seen.current = { key: filterKey, top: Math.max(newest, before?.key === filterKey ? before.top : 0) };
    if (!before || before.key !== filterKey || newest <= before.top) return;
    const arrived = entries.filter((e) => e.id > before.top).map((e) => e.id);
    setFresh(new Set(arrived));
    if (away) setUnseen((n) => n + arrived.length);
  }, [newest, filterKey, logs.data]);
  useEffect(() => {
    if (fresh.size === 0) return;
    const timer = setTimeout(() => setFresh(new Set()), 1300);
    return () => clearTimeout(timer);
  }, [fresh]);

  // Whether the top of the list is scrolled out of view, where new rows land unnoticed.
  useEffect(() => {
    const el = top.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      setAway(!entry.isIntersecting);
      if (entry.isIntersecting) setUnseen(0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <PageHeader
        title="请求日志"
        actions={
          <>
            <Button variant={live ? "secondary" : "ghost"} icon={live ? <Dot tone="signal" live /> : <Radio />} onClick={() => setLive(!live)}>
              {live ? "实时" : "已暂停"}
            </Button>
            <Button
              variant="ghost"
              icon={<Trash2 />}
              onClick={async () => {
                if (await confirm({ title: "清空全部日志？", body: "概览页的统计同样来自这些日志，将一并清零。", confirm: "清空", danger: true })) {
                  await api.clearLogs();
                  await client.invalidateQueries({ queryKey: ["logs"] });
                  toast("日志已清空");
                }
              }}
            >
              清空
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          value={tool}
          onChange={setTool}
          options={[{ value: "", label: "全部" }, ...meta.tools.map((t) => ({ value: t as string, label: toolLabel[t] }))]}
        />
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: "全部状态" },
            { value: "ok", label: "成功" },
            { value: "error", label: "失败" },
            { value: "fallback", label: "触发回退" },
          ]}
        />
        <Select
          className="w-36"
          value={provider}
          onChange={setProvider}
          aria-label="按提供商筛选"
          options={[
            { value: "", label: "全部提供商" },
            ...meta.catalog.map((p) => ({ value: p.id, label: p.name })),
            ...config.fetchers.map((f) => ({ value: f.id, label: fetcherLabel(meta, providerInfo(f.id)) })),
            ...(provider && ![...meta.catalog, ...config.fetchers].some((p) => p.id === provider) ? [{ value: provider, label: provider }] : []),
          ]}
        />
        <Select
          className="w-36"
          value={caller}
          onChange={setCaller}
          aria-label="按调用方筛选"
          options={[
            { value: "", label: "全部调用方" },
            { value: "webui", label: "调试台" },
            ...(keys.data ?? []).map((key) => ({ value: String(key.id), label: key.name })),
            ...(caller && caller !== "webui" && keys.data && !keys.data.some((key) => String(key.id) === caller) ? [{ value: caller, label: "已删除的 Key" }] : []),
          ]}
        />
        {range && (
          <button
            type="button"
            onClick={() => setRange(null)}
            className="num press inline-flex h-8 items-center gap-1.5 rounded-ctl bg-fill-strong px-2.5 text-xs text-ink hover:bg-ink-3/20"
            aria-label="清除时间范围"
          >
            时间：{rangeLabel(range.since, range.until)}
            <X className="size-3.5" />
          </button>
        )}
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-2 left-2.5 z-10 size-4 text-ink-3" />
          <Input className="pl-8" value={search} placeholder="搜索查询词、URL、错误信息、IP 或 UA" onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div ref={top} />
      {unseen > 0 && (
        <div className="sticky top-2 z-10 flex justify-center max-md:top-[calc(3.5rem+env(safe-area-inset-top))]">
          <button
            type="button"
            onClick={() => top.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
            className="num -mb-8 inline-flex h-8 animate-in items-center gap-1.5 rounded-full bg-signal px-3 text-xs font-medium text-signal-ink shadow-overlay hover:bg-signal-hover"
          >
            <ArrowUp className="size-3.5" />
            {unseen} 条新记录
          </button>
        </div>
      )}

      {flying.calls.length > 0 && <InFlight calls={flying.calls} origin={flying.origin} onOpen={open} />}

      <Panel flush>
        {logs.isPending ? (
          <Loading rows={10} />
        ) : entries.length === 0 ? (
          <Empty size="page" icon={<ScrollText />} title="没有符合条件的日志" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>时间</Th>
                  <Th>工具</Th>
                  <Th className="w-full">请求</Th>
                  <Th>状态</Th>
                  <Th className="text-right">耗时</Th>
                  <Th className="text-right">Token</Th>
                  <Th>调用方</Th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.id}
                    data-log={entry.id}
                    tabIndex={0}
                    aria-current={inspect === String(entry.id) ? "true" : undefined}
                    onClick={(e) => open(e, entry.id)}
                    onKeyDown={(e) => e.key === "Enter" && open(e, entry.id)}
                    className={cx(
                      "cursor-pointer scroll-my-12 transition-colors hover:bg-fill focus-visible:bg-fill-strong focus-visible:outline-none",
                      "aria-current:bg-fill-strong",
                      fresh.has(entry.id) && "animate-arrive",
                    )}
                  >
                    <Td className="num text-xs whitespace-nowrap text-ink-3">{logTime(entry.ts)}</Td>
                    <Td className="text-xs whitespace-nowrap text-ink-2">{toolLabel[entry.tool] ?? entry.tool}</Td>
                    <Td className="max-w-0 min-w-48">
                      <div className="truncate">{entry.summary}</div>
                      {entry.error === stoppedHere ? (
                        <div className="truncate text-xs text-ink-3">从控制台中止</div>
                      ) : (
                        entry.error && <div className="truncate text-xs text-err">{entry.error}</div>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        {entry.error === stoppedHere ? <Status>已中止</Status> : <StatusBadge status={entry.status} />}
                        {entry.hops && entry.hops.length > 0 && (
                          <Tooltip content={<Route hops={entry.hops} />}>
                            <span className="cursor-help text-xs text-warn">回退</span>
                          </Tooltip>
                        )}
                      </span>
                    </Td>
                    <Td className="num text-right text-xs whitespace-nowrap">{duration(entry.duration_ms)}</Td>
                    <Td className="num text-right text-xs whitespace-nowrap text-ink-3">{entry.input_tokens ? compact(entry.input_tokens + entry.output_tokens) : "—"}</Td>
                    <Td className="max-w-36 truncate text-xs whitespace-nowrap text-ink-3" title={entry.client_ip || undefined}>
                      {callerName(entry)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {logs.hasNextPage && (
          <div className="flex justify-center border-t border-line p-3">
            <Button loading={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>
              加载更早的记录
            </Button>
          </div>
        )}
      </Panel>

      {inspect && (
        <SidePanel label="调用详情" onClose={close} className="md:w-[clamp(40rem,62vw,64rem)]">
          <CallInspector
            id={inspect}
            inPanel
            onWritten={(logId) => setInspect(String(logId))}
            tools={
              <span className="-mr-1.5 flex items-center">
                <Tooltip content="整页打开">
                  <Link href={`/logs/${inspect}`} state={{ from: "logs" }} aria-label="整页打开" className={iconButton()}>
                    <Maximize2 />
                  </Link>
                </Tooltip>
                <Tooltip
                  content={
                    <span className="flex items-center gap-1.5">
                      关闭 <Kbd>Esc</Kbd>
                      <span className="text-ink-3">·</span>
                      上下条 <Kbd>↑</Kbd>
                      <Kbd>↓</Kbd>
                    </span>
                  }
                >
                  <button type="button" aria-label="关闭" onClick={close} className={iconButton()}>
                    <X />
                  </button>
                </Tooltip>
              </span>
            }
          />
        </SidePanel>
      )}
    </>
  );
}

const hopClass: Record<Hop["status"], string> = {
  ok: "text-ink",
  cached: "text-ink-2",
  error: "text-err line-through decoration-err/60",
  skipped: "text-warn line-through decoration-warn/60",
  limited: "text-warn line-through decoration-warn/60",
  canceled: "text-ink-3",
};
const hopTitle: Record<Hop["status"], string> = { ok: "成功", cached: "缓存", error: "失败", skipped: "熔断跳过", limited: "限流跳过", canceled: "对冲取消" };

/**
 * The way a call took when it did not go straight through: each provider or
 * model it passed, struck out where it failed. Search or fetch comes first,
 * the extract models after the dot. Shown over the fallback mark of a row.
 */
function Route({ hops }: { hops: Hop[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 py-0.5">
      {hops.map((hop, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-ink-3">{hops[i - 1].kind === hop.kind ? "→" : "·"}</span>}
          <span className={cx("inline-flex items-center", hopClass[hop.status])} title={`${toolLabel[hop.kind] ?? hop.kind} · ${hopTitle[hop.status]}${hop.count > 1 ? ` × ${hop.count}` : ""}`}>
            {hop.kind === "llm" ? <ProviderName id={hop.provider} kind={hop.kind} /> : <ProviderKind id={hop.provider} />}
            {hop.count > 1 && <span className="num text-ink-3 no-underline"> ×{hop.count}</span>}
          </span>
        </span>
      ))}
    </span>
  );
}

function StatusBadge({ status }: { status: LogEntry["status"] }) {
  return status === "ok" ? (
    <Status tone="ok">成功</Status>
  ) : (
    <Badge tone="err" dot>
      失败
    </Badge>
  );
}

/**
 * The calls being served at this moment, above the list they will join: what
 * each is doing right now, and for how long it has been going.
 */
function InFlight({ calls, origin, onOpen }: { calls: LiveCall[]; origin: (call: LiveCall) => number; onOpen: (e: MouseEvent | KeyboardEvent, id: string) => void }) {
  const now = useNow(true, 500);
  return (
    <section className="mb-3 overflow-hidden rounded-panel border border-signal-text/40 bg-surface">
      <header className="flex h-10 items-center gap-2 border-b border-line px-4">
        <Dot tone="signal" live />
        <h2 className="t-heading text-sm">进行中</h2>
        <span className="num text-xs text-ink-3">{calls.length}</span>
      </header>
      <ul>
        {calls.map((call) => (
          <li
            key={call.call_id}
            tabIndex={0}
            role="link"
            onClick={(e) => onOpen(e, call.call_id)}
            onKeyDown={(e) => e.key === "Enter" && onOpen(e, call.call_id)}
            className="flex min-h-11 animate-in cursor-pointer items-center gap-3 border-b border-line px-4 py-1.5 text-sm transition-colors last:border-b-0 hover:bg-fill focus-visible:bg-fill-strong focus-visible:outline-none max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-0.5"
          >
            <span className="w-12 shrink-0 text-xs text-ink-2">{toolLabel[call.tool] ?? call.tool}</span>
            <span className="min-w-0 flex-1 basis-48 truncate">{call.summary || "—"}</span>
            <LivePhase call={call} className="inline-flex min-w-0 shrink items-center gap-1.5 text-xs text-ink-2 md:max-w-[40%]" />
            <span className="w-24 shrink-0 truncate text-xs text-ink-3 max-md:hidden">{call.source === "webui" ? "调试台" : call.api_key_name || "—"}</span>
            <span className="num w-14 shrink-0 text-right text-xs text-signal-text">{duration(Math.max(0, now - origin(call)))}</span>
            <ChevronRight className="size-3.5 shrink-0 text-ink-3" />
          </li>
        ))}
      </ul>
    </section>
  );
}
