import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { useState } from "react";
import { api, type APIKey, type KeyUsage, type RoutedTool } from "../lib/api";
import { compact, percent, toolLabel } from "../lib/format";
import { Drawer } from "../ui/overlays";
import { cx, Empty, Segmented, Spinner, Table, Td, Th, Tooltip } from "../ui/primitives";
import { ProviderName } from "./ProviderName";

type Days = "7" | "30" | "90" | "365";

const tokens = (n: number | undefined) => (n ? compact(n) : "—");

/** A usage day starts at midnight UTC, so it is named by its UTC date. */
const day = (ts: number) => new Date(ts).toISOString().slice(5, 10);

/** What one key used: calls per day, and the split by tool, provider and model. */
export function KeyUsageDrawer({ apiKey, onClose }: { apiKey: APIKey | null; onClose: () => void }) {
  const [days, setDays] = useState<Days>("30");
  const query = useQuery({
    queryKey: ["key-usage", apiKey?.id, days],
    queryFn: () => api.keyUsage(apiKey!.id, Number(days)),
    enabled: apiKey !== null,
    refetchInterval: 10_000,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === apiKey?.id ? previous : undefined),
  });
  const usage = query.data?.usage;
  return (
    <Drawer
      open={apiKey !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`「${apiKey?.name ?? ""}」的用量`}
      description={`该密钥的调用、上游请求与模型 Token，按 UTC 日累计，保留 ${query.data?.retention_days ?? 400} 天，不随请求日志清理。`}
    >
      <div className="flex flex-col gap-6">
        <div>
          <Segmented
            size="sm"
            value={days}
            onChange={setDays}
            options={[
              { value: "7", label: "7 天" },
              { value: "30", label: "30 天" },
              { value: "90", label: "90 天" },
              { value: "365", label: "1 年" },
            ]}
          />
        </div>
        {!usage ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : usage.total.calls === 0 ? (
          <Empty icon={<BarChart3 />} title="所选时间范围内没有用量">
            用量自升级到本版本起开始累计，此前的调用只在请求日志中。
          </Empty>
        ) : (
          <Report usage={usage} />
        )}
      </div>
    </Drawer>
  );
}

function Report({ usage }: { usage: KeyUsage }) {
  const { total } = usage;
  const kinds = (["search", "dev_search", "fetch"] as RoutedTool[]).filter((kind) => usage.providers.some((p) => p.kind === kind));
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Figure label="调用" value={total.calls.toLocaleString()} detail={total.errors ? `${total.errors} 次失败` : "无失败"} />
        <Figure label="输入 Token" value={tokens(total.input_tokens)} detail={total.cache_read_tokens ? `缓存命中 ${percent(total.cache_read_tokens, total.input_tokens)}` : "无缓存命中"} />
        <Figure label="输出 Token" value={tokens(total.output_tokens)} />
        <Figure label="上游请求" value={usage.providers.reduce((sum, p) => sum + p.calls, 0).toLocaleString()} detail="搜索与抓取提供商" />
      </dl>

      <Group title="每日调用">
        <Daily usage={usage} />
      </Group>

      <Group title="工具" hint="研究调用的 Token 包含其过程中的抽取。">
        <Table>
          <thead>
            <tr>
              <Th className="w-full">工具</Th>
              <Th className="text-right">调用</Th>
              <Th className="text-right">失败</Th>
              <Th className="text-right">输入</Th>
              <Th className="text-right">输出</Th>
            </tr>
          </thead>
          <tbody>
            {usage.tools.map((row) => (
              <tr key={row.tool} className="last:[&>td]:border-b-0">
                <Td>{toolLabel[row.tool] ?? row.tool}</Td>
                <Td className="num text-right text-xs">{row.calls.toLocaleString()}</Td>
                <Td className={cx("num text-right text-xs", row.errors ? "text-err" : "text-ink-3")}>{row.errors || "—"}</Td>
                <Td className="num text-right text-xs text-ink-2">{tokens(row.input_tokens)}</Td>
                <Td className="num text-right text-xs text-ink-2">{tokens(row.output_tokens)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Group>

      {kinds.length > 0 && (
        <Group title="上游请求" hint="实际发往提供商的请求数，含失败转移与对冲中多发的请求、研究过程中的搜索与抓取；缓存命中不计。">
          <Table>
            <thead>
              <tr>
                <Th>类型</Th>
                <Th className="w-full">提供商</Th>
                <Th className="text-right">请求</Th>
                <Th className="text-right">失败</Th>
              </tr>
            </thead>
            <tbody>
              {kinds.flatMap((kind) => {
                const rows = usage.providers.filter((p) => p.kind === kind);
                return [
                  ...rows.map((row, i) => (
                    <tr key={`${kind}/${row.provider}`}>
                      <Td className="whitespace-nowrap text-ink-2">{i === 0 ? toolLabel[kind] : ""}</Td>
                      <Td>
                        <ProviderName id={row.provider} />
                      </Td>
                      <Td className="num text-right text-xs">{row.calls.toLocaleString()}</Td>
                      <Td className={cx("num text-right text-xs", row.errors ? "text-err" : "text-ink-3")}>{row.errors || "—"}</Td>
                    </tr>
                  )),
                  rows.length > 1 && (
                    <tr key={`${kind}/sum`} className="text-ink-3">
                      <Td />
                      <Td className="text-xs">合计</Td>
                      <Td className="num text-right text-xs">{rows.reduce((sum, r) => sum + r.calls, 0).toLocaleString()}</Td>
                      <Td className="num text-right text-xs">{rows.reduce((sum, r) => sum + r.errors, 0) || "—"}</Td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </Table>
        </Group>
      )}

      {usage.models.length > 0 && (
        <Group title="模型" hint="一次研究记为对其模型的一次请求，无论其中有多少轮。">
          <Table>
            <thead>
              <tr>
                <Th className="w-full">模型</Th>
                <Th className="text-right">请求</Th>
                <Th className="text-right">输入</Th>
                <Th className="text-right">输出</Th>
                <Th className="text-right whitespace-nowrap">缓存读 / 写</Th>
              </tr>
            </thead>
            <tbody>
              {usage.models.map((row) => (
                <tr key={row.model} className="last:[&>td]:border-b-0">
                  <Td className="num text-xs">{row.model}</Td>
                  <Td className="num text-right text-xs">{row.calls.toLocaleString()}</Td>
                  <Td className="num text-right text-xs text-ink-2">{tokens(row.input_tokens)}</Td>
                  <Td className="num text-right text-xs text-ink-2">{tokens(row.output_tokens)}</Td>
                  <Td className="num text-right text-xs whitespace-nowrap text-ink-3">
                    {tokens(row.cache_read_tokens)} / {tokens(row.cache_write_tokens)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Group>
      )}
    </>
  );
}

function Figure({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <dt className="tag normal-case">{label}</dt>
      <dd className="num mt-1 text-xl">{value}</dd>
      {detail && <dd className="mt-0.5 text-xs text-ink-3">{detail}</dd>}
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-medium">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
      <div className="mt-3 overflow-x-auto">{children}</div>
    </section>
  );
}

function Daily({ usage }: { usage: KeyUsage }) {
  const peak = Math.max(1, ...usage.days.map((d) => d.calls));
  return (
    <div>
      <div className="flex h-24 items-end gap-px">
        {usage.days.map((d) => (
          <Tooltip
            key={d.ts}
            content={
              <span className="num flex flex-col gap-0.5">
                <span className="text-ink">
                  {day(d.ts)} · {d.calls} 次{d.errors ? ` · ${d.errors} 失败` : ""}
                </span>
                {d.input_tokens > 0 && (
                  <span>
                    Token {compact(d.input_tokens)} 入 / {compact(d.output_tokens)} 出
                  </span>
                )}
              </span>
            }
          >
            <div className="flex h-full min-w-0 flex-1 flex-col justify-end" aria-label={`${day(d.ts)}，${d.calls} 次调用`}>
              {d.calls === 0 ? (
                <span className="h-px bg-line-strong" />
              ) : (
                <>
                  {d.errors > 0 && <span className="rounded-t-[2px] bg-err" style={{ height: `${Math.max(2, (d.errors / peak) * 100)}%` }} />}
                  <span className={cx("bg-signal", d.errors === 0 && "rounded-t-[2px]")} style={{ height: `${Math.max(1, ((d.calls - d.errors) / peak) * 100)}%` }} />
                </>
              )}
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="tag mt-2 flex justify-between normal-case">
        <span>{day(usage.days[0].ts)}</span>
        <span>峰值 {peak} 次 / 日</span>
        <span>{day(usage.days[usage.days.length - 1].ts)}</span>
      </div>
    </div>
  );
}
