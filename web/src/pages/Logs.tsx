import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ExternalLink, Radio, ScrollText, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearch } from "wouter";
import { ProviderName, ProviderNames } from "../components/ProviderName";
import { Waterfall } from "../components/Waterfall";
import { api, type Hop, type LogEntry } from "../lib/api";
import { useConfig } from "../lib/config";
import { clientName, compact, dateTime, duration, logTime, percent, toolLabel } from "../lib/format";
import { PageHeader } from "../Shell";
import { Drawer, useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, CodeBlock, cx, Dot, Empty, Input, Panel, Segmented, Select, Spinner, Table, Td, Th } from "../ui/primitives";

const pageSize = 50;

function pretty(json: string | undefined): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    // A captured body is cut at a size limit, which leaves invalid JSON.
    return json;
  }
}

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

export function LogsPage() {
  const { meta } = useConfig();
  const client = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // The overview links here with filters in the address.
  const address = useSearch();
  const [params] = useState(() => new URLSearchParams(address));
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
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);

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
  // refetch reloads every page shown.
  useEffect(() => {
    if (!live) return;
    const source = new EventSource("/api/logs/stream");
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void client.invalidateQueries({ queryKey: ["logs"] });
      }, 1000);
    };
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [live, client]);

  const entries = logs.data?.pages.flat() ?? [];
  const newest = entries[0]?.id ?? 0;

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
        description="每次工具调用，及其对各提供商的每次请求。"
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
        <Select className="w-36" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="按提供商筛选">
          <option value="">全部提供商</option>
          {meta.catalog.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {provider && !meta.catalog.some((p) => p.id === provider) && <option value={provider}>{provider}</option>}
        </Select>
        <Select className="w-36" value={caller} onChange={(e) => setCaller(e.target.value)} aria-label="按调用方筛选">
          <option value="">全部调用方</option>
          <option value="webui">调试台</option>
          {keys.data?.map((key) => (
            <option key={key.id} value={key.id}>
              {key.name}
            </option>
          ))}
          {caller && caller !== "webui" && keys.data && !keys.data.some((key) => String(key.id) === caller) && <option value={caller}>已删除的 Key</option>}
        </Select>
        {range && (
          <button
            type="button"
            onClick={() => setRange(null)}
            className="num inline-flex h-8 items-center gap-1.5 rounded-ctl border border-line-strong bg-raised px-2.5 text-xs text-ink-2 transition-colors hover:text-ink"
            aria-label="清除时间范围"
          >
            时间：{rangeLabel(range.since, range.until)}
            <X className="size-3.5" />
          </button>
        )}
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-ink-3" />
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

      <Panel flush>
        {logs.isPending ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <Empty icon={<ScrollText />} title="没有符合条件的日志">
            Agent 调用工具或在调试台发起请求后，记录将显示在此处。
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>时间</Th>
                  <Th>工具</Th>
                  <Th className="w-full">请求</Th>
                  <Th>提供商</Th>
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
                    tabIndex={0}
                    onClick={() => setSelected(entry.id)}
                    onKeyDown={(e) => e.key === "Enter" && setSelected(entry.id)}
                    className={cx("cursor-pointer transition-colors hover:bg-raised/60 focus-visible:bg-raised", fresh.has(entry.id) && "animate-arrive")}
                  >
                    <Td className="num text-xs whitespace-nowrap text-ink-3">{logTime(entry.ts)}</Td>
                    <Td>
                      <Badge>{toolLabel[entry.tool] ?? entry.tool}</Badge>
                    </Td>
                    <Td className="max-w-0 min-w-48">
                      <div className="truncate">{entry.summary}</div>
                      {entry.error && <div className="truncate text-xs text-err">{entry.error}</div>}
                    </Td>
                    <Td className="text-xs whitespace-nowrap text-ink-2">
                      {entry.hops ? <Route hops={entry.hops} /> : entry.provider ? <ProviderNames ids={entry.provider} kind={entry.tool === "research" ? "llm" : undefined} /> : "—"}
                    </Td>
                    <Td>
                      <StatusBadge status={entry.status} />
                    </Td>
                    <Td className="num text-right text-xs whitespace-nowrap">{duration(entry.duration_ms)}</Td>
                    <Td className="num text-right text-xs whitespace-nowrap text-ink-3">{entry.input_tokens ? compact(entry.input_tokens + entry.output_tokens) : "—"}</Td>
                    <Td className="text-xs whitespace-nowrap text-ink-3">
                      <div>{callerName(entry)}</div>
                      {entry.client_ip && <div className="num text-2xs text-ink-3/80">{entry.client_ip}</div>}
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

      <LogDrawer id={selected} onClose={() => setSelected(null)} />
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
 * the extract models after the dot.
 */
function Route({ hops }: { hops: Hop[] }) {
  return (
    <span className="flex items-center gap-1.5">
      <Badge tone="warn">回退</Badge>
      {hops.map((hop, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-ink-3">{hops[i - 1].kind === hop.kind ? "→" : "·"}</span>}
          <span className={cx("inline-flex items-center", hopClass[hop.status])} title={`${toolLabel[hop.kind] ?? hop.kind} · ${hopTitle[hop.status]}${hop.count > 1 ? ` × ${hop.count}` : ""}`}>
            <ProviderName id={hop.provider} kind={hop.kind} />
            {hop.count > 1 && <span className="num text-ink-3 no-underline"> ×{hop.count}</span>}
          </span>
        </span>
      ))}
    </span>
  );
}

function StatusBadge({ status }: { status: LogEntry["status"] }) {
  return status === "ok" ? (
    <Badge tone="ok" dot>
      成功
    </Badge>
  ) : (
    <Badge tone="err" dot>
      失败
    </Badge>
  );
}

function Fact({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="tag">{label}</div>
      <div className="mt-0.5 truncate text-sm">{children}</div>
    </div>
  );
}

function LogDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const log = useQuery({ queryKey: ["log", id], queryFn: () => api.log(id!), enabled: id !== null });
  const entry = log.data;
  return (
    <Drawer open={id !== null} onOpenChange={(open) => !open && onClose()} title={entry ? `${toolLabel[entry.tool] ?? entry.tool} · #${entry.id}` : "日志详情"} description={entry ? dateTime(entry.ts) : undefined}>
      {!entry ? (
        <div className="grid place-items-center py-16">{log.error ? <span className="text-sm text-err">{log.error.message}</span> : <Spinner />}</div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Fact label="状态">
              <StatusBadge status={entry.status} />
            </Fact>
            <Fact label="总耗时">
              <span className="num">{duration(entry.duration_ms)}</span>
            </Fact>
            <Fact label="响应提供商">{entry.provider ? <ProviderNames ids={entry.provider} kind={entry.tool === "research" ? "llm" : undefined} /> : "—"}</Fact>
            <Fact label="调用方">{callerName(entry)}</Fact>
            <Fact label="来源 IP">
              <span className="num">{entry.client_ip || "—"}</span>
            </Fact>
            <Fact label="客户端" className="col-span-1 sm:col-span-3">
              <span className="num" title={entry.user_agent}>
                {clientName(entry.user_agent) || "—"}
              </span>
            </Fact>
            {entry.input_tokens > 0 && (
              <>
                <Fact label="Token（输入 / 输出）" className="col-span-2">
                  <span className="num">
                    {entry.input_tokens.toLocaleString()} / {entry.output_tokens.toLocaleString()}
                  </span>
                </Fact>
                <Fact label="缓存（读取 / 写入）">
                  <span className="num">
                    {(entry.cache_read_tokens ?? 0).toLocaleString()} / {(entry.cache_write_tokens ?? 0).toLocaleString()}
                  </span>
                </Fact>
                <Fact label="缓存命中率">
                  <span className="num">{percent(entry.cache_read_tokens ?? 0, entry.input_tokens)}</span>
                </Fact>
              </>
            )}
          </div>

          {entry.task_id && (
            <a href={`/report/${entry.task_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 self-start text-sm text-signal-text underline-offset-2 hover:underline">
              <ExternalLink className="size-3.5" />
              查看研究报告
            </a>
          )}

          {entry.user_agent && (
            <section>
              <h3 className="tag mb-1.5">User-Agent</h3>
              <CodeBlock wrap copy>
                {entry.user_agent}
              </CodeBlock>
            </section>
          )}

          {entry.error && (
            <section>
              <h3 className="tag mb-1.5">错误</h3>
              <CodeBlock wrap className="border-err/30 [&_pre]:text-err">
                {entry.error}
              </CodeBlock>
            </section>
          )}

          <section>
            <h3 className="tag mb-1.5">调用链 · {entry.attempts?.length ?? 0} 次请求</h3>
            {entry.attempts?.length ? <Waterfall attempts={entry.attempts} total={entry.duration_ms} /> : <div className="text-xs text-ink-3">本次调用未请求任何上游提供商</div>}
          </section>

          <section>
            <h3 className="tag mb-1.5">请求参数</h3>
            <CodeBlock copy>{pretty(entry.request)}</CodeBlock>
          </section>

          <section>
            <h3 className="tag mb-1.5">返回内容</h3>
            {entry.response ? (
              <CodeBlock copy wrap className="max-h-[28rem]">
                {pretty(entry.response)}
              </CodeBlock>
            ) : (
              <div className="text-xs text-ink-3">未记录。可在「系统」页开启返回内容记录。</div>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
