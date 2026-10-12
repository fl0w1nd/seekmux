import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api, type Overview, type RouteStatus, type Tool } from "../lib/api";
import { Tripped } from "../components/Health";
import { ProviderName } from "../components/ProviderName";
import { ago, bytes, compact, dateTime, duration, percent, toolLabel } from "../lib/format";
import { useTween } from "../lib/motion";
import { PageHeader } from "../Shell";
import { Badge, cx, Dot, Empty, Meter, Notice, Panel, Segmented, Spinner, Table, Td, Th, Tooltip } from "../ui/primitives";

type Window = "1h" | "24h" | "7d";

/** The width of one histogram bucket, e.g. "5 分钟". */
const stepLabel = (step: number) => (step >= 3600_000 ? `${step / 3600_000} 小时` : `${step / 60_000} 分钟`);

const windows: Record<Window, { label: string; span: number; step: number }> = {
  "1h": { label: "1 小时", span: 3600_000, step: 300_000 },
  "24h": { label: "24 小时", span: 86400_000, step: 3600_000 },
  "7d": { label: "7 天", span: 7 * 86400_000, step: 6 * 3600_000 },
};

export function OverviewPage() {
  const [window, setWindow] = useState<Window>("24h");
  const overview = useQuery({ queryKey: ["overview", window], queryFn: () => api.overview(window), refetchInterval: 5000, placeholderData: (previous) => previous });
  const data = overview.data;

  // Panels are numbered in reading order, and some only show when they have something to say.
  let panel = 0;
  const next = () => String(++panel).padStart(2, "0");

  return (
    <>
      <PageHeader
        title="概览"
        description="网关当前的状态，以及各提供商在所选时间窗内的实际表现。"
        actions={<Segmented value={window} onChange={setWindow} options={(Object.keys(windows) as Window[]).map((w) => ({ value: w, label: windows[w].label }))} />}
      />
      {!data ? (
        <div className="grid place-items-center py-24">{overview.error ? <span className="text-sm text-err">{overview.error.message}</span> : <Spinner />}</div>
      ) : (
        <div className="flex flex-col gap-4">
          <Kpis data={data} />
          <Panel index={next()} title="请求量" description={`时间粒度：${stepLabel(windows[window].step)}；点击柱条查看该时段的日志`}>
            <Histogram key={window} data={data} window={window} />
          </Panel>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Routes tool="search" title="搜索路由" index={next()} routes={data.routes} />
            <Routes tool="fetch" title="抓取路由" index={next()} routes={data.routes} />
            {data.routes.some((r) => r.tool === "dev_search") && <Routes tool="dev_search" title="开发搜索路由" index={next()} routes={data.routes} />}
          </div>
          {data.models.length > 0 && <Models data={data} index={next()} />}
          {data.stats.errors.length > 0 && <Errors data={data} index={next()} />}
          <Providers data={data} index={next()} />
          <Callers data={data} index={next()} />
          <Roles data={data} />
        </div>
      )}
    </>
  );
}

function Kpis({ data }: { data: Overview }) {
  const tools = data.stats.tools;
  const calls = tools.reduce((sum, t) => sum + t.calls, 0);
  const errors = tools.reduce((sum, t) => sum + t.errors, 0);
  const by = (tool: string) => tools.find((t) => t.tool === tool);
  const tokens = data.stats.input_tokens + data.stats.output_tokens;
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-panel border border-line bg-line gap-px lg:grid-cols-4">
      <Kpi label="调用" value={calls} format={(n) => compact(Math.round(n))} detail={tools.length ? tools.map((t) => `${toolLabel[t.tool]} ${compact(t.calls)}`).join(" · ") : "暂无调用"} />
      <Kpi
        label="成功率"
        value={calls ? (calls - errors) / calls : null}
        format={(n) => percent(n, 1)}
        tone={errors > 0 && errors / calls > 0.1 ? "text-warn" : undefined}
        detail={errors ? `${errors} 次失败` : "无失败"}
      />
      <Kpi
        label="P50 耗时"
        value={by("search")?.p50_ms ?? null}
        format={duration}
        unit="搜索"
        detail={`抓取 ${by("fetch") ? duration(by("fetch")!.p50_ms) : "—"} · P95 ${by("search") ? duration(by("search")!.p95_ms) : "—"} / ${by("fetch") ? duration(by("fetch")!.p95_ms) : "—"}`}
      />
      <Kpi
        label="模型 Token"
        value={tokens}
        format={(n) => compact(Math.round(n))}
        detail={`输入 ${compact(data.stats.input_tokens)} · 输出 ${compact(data.stats.output_tokens)} · 缓存命中 ${percent(data.stats.cache_read_tokens ?? 0, data.stats.input_tokens)}`}
      />
    </div>
  );
}

/** A headline figure that moves to its new value instead of jumping; null shows as a dash. */
function Kpi({ label, value, format, unit, detail, tone }: { label: string; value: number | null; format: (n: number) => string; unit?: string; detail: ReactNode; tone?: string }) {
  const shown = useTween(value ?? 0);
  return (
    <div className="bg-surface px-4 py-3.5">
      <div className="tag">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={cx("num text-2xl font-medium", tone)}>{value === null ? "—" : format(shown)}</span>
        {unit && <span className="text-xs text-ink-3">{unit}</span>}
      </div>
      <div className="mt-0.5 truncate text-xs text-ink-3">{detail}</div>
    </div>
  );
}

/** The tools in the order they stack, bottom up, each with its own shade. */
const stack: { tool: Tool; bar: string }[] = [
  { tool: "search", bar: "bg-signal-text" },
  { tool: "fetch", bar: "bg-signal-text/55" },
  { tool: "dev_search", bar: "bg-info" },
  { tool: "research", bar: "bg-ink-3" },
];

function Histogram({ data, window }: { data: Overview; window: Window }) {
  const [, navigate] = useLocation();
  const { span, step } = windows[window];
  const found = new Map(data.stats.buckets.map((b) => [Math.floor(b.ts / step) * step, b]));
  const end = Math.floor(Date.now() / step) * step;
  const slots = Array.from({ length: Math.round(span / step) }, (_, i) => {
    const ts = end - (Math.round(span / step) - 1 - i) * step;
    return found.get(ts) ?? { ts, calls: 0, errors: 0, tools: {} };
  });
  const peak = Math.max(1, ...slots.map((s) => s.calls));
  const used = stack.filter((s) => slots.some((slot) => slot.tools?.[s.tool]));
  if (slots.every((s) => s.calls === 0)) {
    return (
      <Empty icon={<Activity />} title="所选时间范围内没有请求">
        接入 Agent，或在调试台发起一次请求。
      </Empty>
    );
  }
  return (
    <div>
      <div className="flex h-28 items-end gap-0.5">
        {slots.map((slot, i) => {
          const ok = slot.calls - slot.errors;
          return (
            <Tooltip
              key={slot.ts}
              content={
                <span className="num flex flex-col gap-0.5">
                  <span className="text-ink">
                    {shortTime(slot.ts)} · {slot.calls} 次{slot.errors ? ` · ${slot.errors} 失败` : ""}
                  </span>
                  {stack.map(({ tool }) => slot.tools?.[tool] ? <span key={tool}>{toolLabel[tool]} {slot.tools[tool]}</span> : null)}
                </span>
              }
            >
              <button
                type="button"
                onClick={() => slot.calls > 0 && navigate(`/logs?since=${slot.ts}&until=${slot.ts + step}`)}
                aria-label={`${shortTime(slot.ts)}，${slot.calls} 次调用`}
                className={cx(
                  "flex h-full min-w-0 flex-1 origin-bottom animate-grow-y flex-col justify-end rounded-t-[2px] transition-opacity",
                  slot.calls > 0 ? "cursor-pointer hover:opacity-80" : "cursor-default",
                )}
                style={{ animationDelay: `${Math.round((i / slots.length) * 240)}ms` }}
              >
                {slot.calls === 0 ? (
                  <span className="h-px bg-line-strong" />
                ) : (
                  <>
                    {slot.errors > 0 && <span className="rounded-t-[2px] bg-err transition-[height] duration-500 ease-settle" style={{ height: `${Math.max(2, (slot.errors / peak) * 100)}%` }} />}
                    {/* Errors are not split by tool: the tools share the rest of the bar in proportion. */}
                    {stack
                      .slice()
                      .reverse()
                      .map(({ tool, bar }, j, list) => {
                        const n = slot.tools?.[tool] ?? 0;
                        if (!n) return null;
                        const first = slot.errors === 0 && list.slice(0, j).every((t) => !slot.tools?.[t.tool]);
                        return (
                          <span
                            key={tool}
                            className={cx("transition-[height] duration-500 ease-settle", bar, first && "rounded-t-[2px]")}
                            style={{ height: `${Math.max(1, ((ok * (n / slot.calls)) / peak) * 100)}%` }}
                          />
                        );
                      })}
                  </>
                )}
              </button>
            </Tooltip>
          );
        })}
      </div>
      <div className="tag mt-2 flex justify-between normal-case">
        <span>{shortTime(slots[0].ts)}</span>
        <span>峰值 {peak} 次 / {stepLabel(step)}</span>
        <span>当前</span>
      </div>
      {used.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
          {used.map(({ tool, bar }) => (
            <span key={tool} className="inline-flex items-center gap-1.5">
              <span className={cx("size-2 rounded-[2px]", bar)} />
              {toolLabel[tool]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-err" />
            失败
          </span>
        </div>
      )}
    </div>
  );
}

const shortTime = (ts: number) => dateTime(ts).slice(5, 16);

function Routes({ tool, title, index, routes }: { tool: string; title: string; index: string; routes: RouteStatus[] }) {
  const list = routes.filter((r) => r.tool === tool);
  return (
    <Panel index={index} title={title} description="按优先级排列；限流属于提供商，同一提供商在各工具中的用量合并计数，实时更新。" flush>
      <ol>
        {list.map((route, i) => (
          <li key={route.provider} className={cx("flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0", !route.available && "opacity-55")}>
            <span className="tag w-4">{String(i + 1).padStart(2, "0")}</span>
            <Dot tone={route.available ? (route.disabled || (route.limit > 0 && route.used >= route.limit) ? "warn" : "ok") : "neutral"} live={route.active > 0} />
            <ProviderName id={route.provider} className="w-28 text-sm" icon="size-4" />
            <span className="flex flex-1 items-center justify-end gap-3">
              {route.disabled ? (
                <Tripped id={route.key} health={route} />
              ) : route.available ? (
                <>
                  {route.active > 0 && <span className="num text-xs text-signal-text">{route.active} 进行中</span>}
                  <Meter used={route.used} limit={route.limit} />
                  <span className="num w-20 text-right text-xs text-ink-3">{route.limit > 0 ? `${route.used}/${route.rate_limit}` : "不限流"}</span>
                </>
              ) : (
                <span className="text-xs text-ink-3">{route.enabled ? "缺少 API Key" : "已停用"}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

const roleLabel = { extract: "提取", research: "研究" } as const;

function Models({ data, index }: { data: Overview; index: string }) {
  return (
    <Panel index={index} title="模型" description="模型的限流由所有使用它的功能共用。" flush>
      <ol>
        {data.models.map((model) => (
          <li key={model.id} className={cx("flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0", model.roles.length === 0 && "opacity-55")}>
            <Dot tone={model.roles.length === 0 ? "neutral" : model.disabled || (model.limit > 0 && model.used >= model.limit) ? "warn" : "ok"} live={model.active > 0} />
            <span className="num min-w-0 truncate text-sm">{model.id}</span>
            <span className="flex gap-1">
              {model.roles.map((role) => (
                <Badge key={role}>{roleLabel[role]}</Badge>
              ))}
            </span>
            <span className="flex flex-1 items-center justify-end gap-3">
              {model.disabled ? (
                <Tripped id={model.key} health={model} />
              ) : (
                <>
                  {model.active > 0 && <span className="num text-xs text-signal-text">{model.active} 进行中</span>}
                  <Meter used={model.used} limit={model.limit} />
                  <span className="num w-20 text-right text-xs text-ink-3">{model.limit > 0 ? `${model.used}/${model.rate_limit}` : "不限流"}</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function Errors({ data, index }: { data: Overview; index: string }) {
  return (
    <Panel index={index} title="错误分布" description="对上游的失败请求，按提供商与 HTTP 状态归并，含被回退挽回的失败；点击查看相关日志" flush>
      <div className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              <Th>提供商</Th>
              <Th>用途</Th>
              <Th className="text-right">HTTP</Th>
              <Th className="text-right">次数</Th>
              <Th className="w-full">最近一次错误</Th>
              <Th className="text-right">最近</Th>
            </tr>
          </thead>
          <tbody>
            {data.stats.errors.map((row) => (
              <tr key={`${row.kind}/${row.provider}/${row.http_status ?? 0}`} className="transition-colors hover:bg-raised/60">
                <Td className="whitespace-nowrap">
                  <Link href={`/logs?provider=${encodeURIComponent(row.provider)}&status=fallback`} className="underline-offset-2 hover:underline">
                    <ProviderName id={row.provider} kind={row.kind} className="text-sm" />
                  </Link>
                </Td>
                <Td>
                  <Badge>{toolLabel[row.kind] ?? row.kind}</Badge>
                </Td>
                <Td className="num text-right text-xs text-err">{row.http_status || "—"}</Td>
                <Td className="num text-right text-xs">{row.count}</Td>
                <Td className="max-w-0">
                  <div className="num truncate text-xs text-ink-2" title={row.sample}>
                    {row.sample || "—"}
                  </div>
                </Td>
                <Td className="text-right text-xs whitespace-nowrap text-ink-3">{ago(row.last_ts)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Panel>
  );
}

function Providers({ data, index }: { data: Overview; index: string }) {
  const rows = data.stats.providers;
  return (
    <Panel index={index} title="提供商表现" description="按对上游的每次请求统计，包含因故障转移被跳过和在对冲中被取消的请求" flush>
      {rows.length === 0 ? (
        <Empty title="暂无数据" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>用途</Th>
                <Th className="w-full">提供商</Th>
                <Th className="text-right">请求数</Th>
                <Th className="text-right">成功率</Th>
                <Th className="text-right">采纳数</Th>
                <Th className="text-right">取消</Th>
                <Th className="text-right">P50</Th>
                <Th className="text-right">P95</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const settled = row.calls - row.canceled;
                const bad = settled > 0 && row.errors / settled > 0.2;
                return (
                  <tr key={`${row.kind}/${row.provider}`}>
                    <Td>
                      <Badge>{toolLabel[row.kind] ?? row.kind}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <ProviderName id={row.provider} kind={row.kind} className={row.kind === "llm" ? "text-xs" : undefined} />
                    </Td>
                    <Td className="num text-right text-xs">{row.calls}</Td>
                    <Td className={cx("num text-right text-xs", bad && "text-err")}>{percent(settled - row.errors, settled)}</Td>
                    <Td className="num text-right text-xs text-ink-2">{row.wins}</Td>
                    <Td className="num text-right text-xs text-ink-3">{row.canceled || "—"}</Td>
                    <Td className="num text-right text-xs">{duration(row.p50_ms)}</Td>
                    <Td className="num text-right text-xs text-ink-2">{duration(row.p95_ms)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

function Callers({ data, index }: { data: Overview; index: string }) {
  const rows = data.stats.callers;
  return (
    <Panel index={index} title="调用方" description="按 API Key 统计的工具调用；来源 IP 突然变多可能意味着 Key 已外泄；点击名称查看其日志" flush>
      {rows.length === 0 ? (
        <Empty title="暂无数据" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th className="w-full">调用方</Th>
                <Th className="text-right">调用数</Th>
                <Th className="text-right">成功率</Th>
                <Th className="text-right">来源 IP</Th>
                <Th className="text-right">输入 Token</Th>
                <Th className="text-right">输出 Token</Th>
                <Th className="text-right">P50</Th>
                <Th className="text-right">P95</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = row.source === "webui" ? "webui" : String(row.api_key_id ?? "");
                const name = row.source === "webui" ? "调试台" : row.api_key_name || "—";
                return (
                  <tr key={`${row.source}/${id}`}>
                    <Td className="whitespace-nowrap">
                      {id ? (
                        <Link href={`/logs?caller=${id}`} className="underline-offset-2 hover:underline">
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                    </Td>
                    <Td className="num text-right text-xs">{row.calls}</Td>
                    <Td className={cx("num text-right text-xs", row.errors / row.calls > 0.2 && "text-err")}>{percent(row.calls - row.errors, row.calls)}</Td>
                    <Td className="num text-right text-xs text-ink-2">{row.ips || "—"}</Td>
                    <Td className="num text-right text-xs text-ink-2">{row.input_tokens ? compact(row.input_tokens) : "—"}</Td>
                    <Td className="num text-right text-xs text-ink-2">{row.output_tokens ? compact(row.output_tokens) : "—"}</Td>
                    <Td className="num text-right text-xs">{duration(row.p50_ms)}</Td>
                    <Td className="num text-right text-xs text-ink-2">{duration(row.p95_ms)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

function Roles({ data }: { data: Overview }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-xs text-ink-3">
        <span className="flex items-center gap-2">
          <Dot tone={data.roles.extract ? "ok" : "neutral"} />
          提取模型{data.roles.extract ? "已配置" : "未配置"}
        </span>
        <span className="flex items-center gap-2">
          <Dot tone={data.roles.research ? "ok" : "neutral"} />
          深度研究{data.roles.research ? "已启用" : "未启用"}
        </span>
        <span className="num">
          页面缓存 {data.cache.pages} 页 · {bytes(data.cache.bytes)}
        </span>
      </div>
      {!data.roles.extract && (
        <Notice tone="warn">
          尚未配置提取模型，fetch 仅能返回原始页面，带 prompt 的调用将回退为截断的原文。请前往{" "}
          <Link href="/tools/fetch" className="text-ink underline underline-offset-2">
            网页抓取
          </Link>{" "}
          设置。
        </Notice>
      )}
    </div>
  );
}
