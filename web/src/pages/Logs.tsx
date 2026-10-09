import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, ScrollText, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Waterfall } from "../components/Waterfall";
import { api, type Hop, type LogEntry } from "../lib/api";
import { useConfig } from "../lib/config";
import { compact, dateTime, duration, logTime, toolLabel } from "../lib/format";
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

export function LogsPage() {
  const { meta } = useConfig();
  const client = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [tool, setTool] = useState("");
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = { tool, provider, q: query, ...(status === "fallback" ? { fallback: 1 } : { status }) };
  const logs = useInfiniteQuery({
    queryKey: ["logs", filters],
    queryFn: ({ pageParam }) => api.logs({ ...filters, before: pageParam, limit: pageSize }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === pageSize ? last[last.length - 1].id : undefined),
  });

  // New entries arrive over SSE; refetching keeps the active filters authoritative.
  useEffect(() => {
    if (!live) return;
    const source = new EventSource("/api/logs/stream");
    source.onmessage = () => void client.invalidateQueries({ queryKey: ["logs"] });
    return () => source.close();
  }, [live, client]);

  const entries = logs.data?.pages.flat() ?? [];

  return (
    <>
      <PageHeader
        title="请求日志"
        description="每一次工具调用，以及它背后对各提供商的每一次尝试。"
        actions={
          <>
            <Button variant={live ? "secondary" : "ghost"} icon={live ? <Dot tone="signal" live /> : <Radio />} onClick={() => setLive(!live)}>
              {live ? "实时" : "已暂停"}
            </Button>
            <Button
              variant="ghost"
              icon={<Trash2 />}
              onClick={async () => {
                if (await confirm({ title: "清空全部日志？", body: "概览页的统计也来自这些日志，会一并清零。", confirm: "清空", danger: true })) {
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
            { value: "fallback", label: "有回退" },
          ]}
        />
        <Select className="w-36" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="按提供商筛选">
          <option value="">全部提供商</option>
          {meta.catalog.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-ink-3" />
          <Input className="pl-8" value={search} placeholder="搜索查询词、URL 或错误信息" onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <Panel flush>
        {logs.isPending ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <Empty icon={<ScrollText />} title="没有符合条件的日志">
            Agent 调用工具，或在调试台发起请求后，记录会出现在这里。
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
                  <tr key={entry.id} tabIndex={0} onClick={() => setSelected(entry.id)} onKeyDown={(e) => e.key === "Enter" && setSelected(entry.id)} className="cursor-pointer transition-colors hover:bg-raised/60 focus-visible:bg-raised">
                    <Td className="num text-xs whitespace-nowrap text-ink-3">{logTime(entry.ts)}</Td>
                    <Td>
                      <Badge>{toolLabel[entry.tool] ?? entry.tool}</Badge>
                    </Td>
                    <Td className="max-w-0">
                      <div className="truncate">{entry.summary}</div>
                      {entry.error && <div className="truncate text-xs text-err">{entry.error}</div>}
                    </Td>
                    <Td className="num text-xs whitespace-nowrap text-ink-2">{entry.hops ? <Route hops={entry.hops} /> : entry.provider || "—"}</Td>
                    <Td>
                      <StatusBadge status={entry.status} />
                    </Td>
                    <Td className="num text-right text-xs whitespace-nowrap">{duration(entry.duration_ms)}</Td>
                    <Td className="num text-right text-xs whitespace-nowrap text-ink-3">{entry.input_tokens ? compact(entry.input_tokens + (entry.output_tokens ?? 0)) : "—"}</Td>
                    <Td className="text-xs whitespace-nowrap text-ink-3">{entry.source === "webui" ? "调试台" : entry.api_key_name || "—"}</Td>
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
  canceled: "text-ink-3",
};
const hopTitle: Record<Hop["status"], string> = { ok: "成功", cached: "缓存", error: "失败", skipped: "已熔断，跳过", canceled: "竞速中被取消" };

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
          <span className={hopClass[hop.status]} title={`${toolLabel[hop.kind] ?? hop.kind} · ${hopTitle[hop.status]}${hop.count > 1 ? ` × ${hop.count}` : ""}`}>
            {hop.provider}
            {hop.count > 1 && <span className="text-ink-3 no-underline"> ×{hop.count}</span>}
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
            <Fact label="应答方">
              <span className="num">{entry.provider || "—"}</span>
            </Fact>
            <Fact label="调用方">{entry.source === "webui" ? "调试台" : entry.api_key_name || "—"}</Fact>
            {Boolean(entry.input_tokens) && (
              <Fact label="Token（输入 / 输出）" className="col-span-2">
                <span className="num">
                  {entry.input_tokens?.toLocaleString()} / {entry.output_tokens?.toLocaleString()}
                </span>
              </Fact>
            )}
          </div>

          {entry.error && (
            <section>
              <h3 className="tag mb-1.5">错误</h3>
              <CodeBlock wrap className="border-err/30 [&_pre]:text-err">
                {entry.error}
              </CodeBlock>
            </section>
          )}

          <section>
            <h3 className="tag mb-1.5">上游调用 · {entry.attempts?.length ?? 0} 次</h3>
            {entry.attempts?.length ? <Waterfall attempts={entry.attempts} total={entry.duration_ms} /> : <div className="text-xs text-ink-3">这次调用没有访问任何提供商。</div>}
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
