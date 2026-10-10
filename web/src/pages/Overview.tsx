import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { api, type Overview, type RouteStatus } from "../lib/api";
import { Tripped } from "../components/Health";
import { useConfig } from "../lib/config";
import { bytes, compact, dateTime, duration, percent, toolLabel } from "../lib/format";
import { PageHeader } from "../Shell";
import { Badge, cx, Dot, Empty, Meter, Notice, Panel, Segmented, Spinner, Table, Td, Th, Tooltip } from "../ui/primitives";

type Window = "1h" | "24h" | "7d";

const windows: Record<Window, { label: string; span: number; step: number }> = {
  "1h": { label: "1 小时", span: 3600_000, step: 300_000 },
  "24h": { label: "24 小时", span: 86400_000, step: 3600_000 },
  "7d": { label: "7 天", span: 7 * 86400_000, step: 6 * 3600_000 },
};

export function OverviewPage() {
  const [window, setWindow] = useState<Window>("24h");
  const overview = useQuery({ queryKey: ["overview", window], queryFn: () => api.overview(window), refetchInterval: 5000, placeholderData: (previous) => previous });
  const data = overview.data;

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
          <Panel index="01" title="请求量" description={`每格 ${windows[window].step >= 3600_000 ? `${windows[window].step / 3600_000} 小时` : `${windows[window].step / 60_000} 分钟`}`}>
            <Histogram data={data} window={window} />
          </Panel>
          <div className="grid gap-4 xl:grid-cols-2">
            <Routes tool="search" title="搜索路由" index="02" routes={data.routes} />
            <Routes tool="fetch" title="抓取路由" index="03" routes={data.routes} />
          </div>
          {data.models.length > 0 && <Models data={data} />}
          <Providers data={data} index={data.models.length > 0 ? "05" : "04"} />
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
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-panel border border-line bg-line gap-px lg:grid-cols-4">
      <Kpi label="调用" value={compact(calls)} detail={tools.length ? tools.map((t) => `${toolLabel[t.tool]} ${compact(t.calls)}`).join(" · ") : "暂无调用"} />
      <Kpi label="成功率" value={percent(calls - errors, calls)} tone={errors > 0 && errors / calls > 0.1 ? "text-warn" : undefined} detail={errors ? `${errors} 次失败` : "无失败"} />
      <Kpi
        label="P50 耗时"
        value={by("search") ? duration(by("search")!.p50_ms) : "—"}
        unit="搜索"
        detail={`抓取 ${by("fetch") ? duration(by("fetch")!.p50_ms) : "—"} · P95 ${by("search") ? duration(by("search")!.p95_ms) : "—"} / ${by("fetch") ? duration(by("fetch")!.p95_ms) : "—"}`}
      />
      <Kpi label="模型 Token" value={compact(data.stats.input_tokens + data.stats.output_tokens)} detail={`输入 ${compact(data.stats.input_tokens)} · 输出 ${compact(data.stats.output_tokens)} · 缓存命中 ${percent(data.stats.cache_read_tokens ?? 0, data.stats.input_tokens)}`} />
    </div>
  );
}

function Kpi({ label, value, unit, detail, tone }: { label: string; value: string; unit?: string; detail: ReactNode; tone?: string }) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <div className="tag">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={cx("num text-2xl font-medium", tone)}>{value}</span>
        {unit && <span className="text-xs text-ink-3">{unit}</span>}
      </div>
      <div className="mt-0.5 truncate text-xs text-ink-3">{detail}</div>
    </div>
  );
}

function Histogram({ data, window }: { data: Overview; window: Window }) {
  const { span, step } = windows[window];
  const found = new Map(data.stats.buckets.map((b) => [Math.floor(b.ts / step) * step, b]));
  const end = Math.floor(Date.now() / step) * step;
  const slots = Array.from({ length: Math.round(span / step) }, (_, i) => {
    const ts = end - (Math.round(span / step) - 1 - i) * step;
    return found.get(ts) ?? { ts, calls: 0, errors: 0 };
  });
  const peak = Math.max(1, ...slots.map((s) => s.calls));
  if (data.stats.buckets.length === 0) {
    return (
      <Empty icon={<Activity />} title="所选时间范围内没有请求">
        接入 Agent，或在调试台发起一次请求。
      </Empty>
    );
  }
  return (
    <div>
      <div className="flex h-28 items-end gap-0.5">
        {slots.map((slot) => (
          <Tooltip
            key={slot.ts}
            content={
              <span className="num">
                {dateTime(slot.ts).slice(5, 16)} · {slot.calls} 次{slot.errors ? ` · ${slot.errors} 失败` : ""}
              </span>
            }
          >
            <div className="flex h-full min-w-0 flex-1 flex-col justify-end">
              {slot.calls === 0 ? (
                <span className="h-px bg-line-strong" />
              ) : (
                <>
                  {slot.errors > 0 && <span className="rounded-t-[2px] bg-err" style={{ height: `${Math.max(2, (slot.errors / peak) * 100)}%` }} />}
                  <span className={cx("bg-signal-text", slot.errors === 0 && "rounded-t-[2px]")} style={{ height: `${Math.max(2, ((slot.calls - slot.errors) / peak) * 100)}%` }} />
                </>
              )}
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="tag mt-2 flex justify-between normal-case">
        <span>{dateTime(slots[0].ts).slice(5, 16)}</span>
        <span>峰值 {peak} 次 / 格</span>
        <span>当前</span>
      </div>
    </div>
  );
}

function Routes({ tool, title, index, routes }: { tool: string; title: string; index: string; routes: RouteStatus[] }) {
  const { provider } = useConfig();
  const list = routes.filter((r) => r.tool === tool);
  return (
    <Panel index={index} title={title} description="按优先级排列；限流属于提供商，同一提供商在各工具中的用量合并计数，实时更新。" flush>
      <ol>
        {list.map((route, i) => (
          <li key={route.provider} className={cx("flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0", !route.available && "opacity-55")}>
            <span className="tag w-4">{String(i + 1).padStart(2, "0")}</span>
            <Dot tone={route.available ? (route.disabled || (route.limit > 0 && route.used >= route.limit) ? "warn" : "ok") : "neutral"} live={route.active > 0} />
            <span className="w-24 truncate text-sm">{provider(route.provider).name}</span>
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
                <span className="text-xs text-ink-3">{route.enabled ? "缺少 API key" : "已停用"}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

const roleLabel = { extract: "提取", research: "研究" } as const;

function Models({ data }: { data: Overview }) {
  return (
    <Panel index="04" title="模型" description="模型的限流由所有使用它的功能共用。" flush>
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

function Providers({ data, index }: { data: Overview; index: string }) {
  const { provider } = useConfig();
  const rows = data.stats.providers;
  return (
    <Panel index={index} title="提供商表现" description="按对上游的每次请求统计，包含因故障转移被跳过和在竞速中被取消的请求。" flush>
      {rows.length === 0 ? (
        <Empty title="暂无数据" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>用途</Th>
                <Th className="w-full">提供商</Th>
                <Th className="text-right">尝试</Th>
                <Th className="text-right">成功率</Th>
                <Th className="text-right">被采用</Th>
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
                    <Td className="whitespace-nowrap">{row.kind === "llm" ? <span className="num text-xs">{row.provider}</span> : provider(row.provider).name}</Td>
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
          <Link href="/fetch" className="text-ink underline underline-offset-2">
            抓取
          </Link>{" "}
          页设置。
        </Notice>
      )}
    </div>
  );
}
