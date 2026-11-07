import { ExternalLink, Puzzle, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { healthLabel, Reenable, useStatus } from "../components/Health";
import type { Provider, WorkerStatus } from "../lib/api";
import { useConfig } from "../lib/config";
import { toolLabel } from "../lib/format";
import { PageHeader } from "../Shell";
import { BrandIcon } from "../ui/brand";
import { RateLimitInput, SecretInput } from "../ui/inputs";
import { Popover } from "../ui/overlays";
import { Badge, Button, CodeBlock, Input, Notice, NumberInput, Panel, Select, Tooltip } from "../ui/primitives";

export function ProvidersPage() {
  const { config, update, meta } = useConfig();
  const status = useStatus();
  return (
    <>
      <PageHeader
        title="提供商"
        description="搜索与抓取服务的凭据、配额与接口地址。同一提供商的密钥、限流和并发由其支持的所有工具共用（并发 0 为不限）；路由顺序与工具专有参数在各工具页面设置。"
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {meta.catalog.map((info, index) => {
          const creds = config.providers[info.id];
          const tools = info.tools;
          const hasKey = Boolean(creds.api_key || (creds.api_key_hint && !creds.clear_api_key));
          const off = status?.routes.filter((r) => r.provider === info.id && r.available && r.disabled) ?? [];
          const hasAuthErr = off.some((r) => r.disabled_reason === "auth");
          const hasQuotaErr = off.some((r) => r.disabled_reason === "quota");
          const hasSetupErr = off.some((r) => r.disabled_reason === "setup");
          const defaultUrl = Object.values(info.default_base_url)[0];
          const set = (change: (p: Provider) => void) => update((d) => void change(d.providers[info.id]));

          const stateBadge = hasAuthErr ? (
            <Badge tone="err" dot>
              密钥被拒
            </Badge>
          ) : hasQuotaErr ? (
            <Badge tone="err" dot>
              额度用尽
            </Badge>
          ) : hasSetupErr ? (
            <Badge tone="err" dot>
              配置失效
            </Badge>
          ) : off.length > 0 ? (
            <Badge tone="warn" dot>
              已熔断
            </Badge>
          ) : info.worker && hasKey ? (
            <WorkerBadge worker={status?.worker} />
          ) : hasKey ? (
            <Badge tone="ok" dot>
              已配置
            </Badge>
          ) : !info.key_required ? (
            <Badge tone="ok" dot>
              免密钥
            </Badge>
          ) : (
            <Badge>未配置</Badge>
          );

          return (
            <Panel
              key={info.id}
              flush
              index={String(index + 1).padStart(2, "0")}
              title={
                <span className="flex items-center gap-2 self-center">
                  <BrandIcon id={info.id} className="size-4" />
                  <span>{info.name}</span>
                  {stateBadge}
                </span>
              }
              actions={
                <>
                  {tools.map((tool) => (
                    <Badge key={tool}>{toolLabel[tool]}</Badge>
                  ))}
                  {info.adapters && info.adapters.length > 0 && <Adapters ids={info.adapters} />}
                  <a
                    href={info.website}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-1 inline-flex items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink"
                  >
                    {info.worker ? "项目" : "控制台"} <ExternalLink className="size-3" />
                  </a>
                </>
              }
            >
              {off.length > 0 && (
                <div className="flex flex-col gap-2 border-b border-line p-3.5">
                  {off.map((route) => {
                    const account = route.disabled_reason === "auth" || route.disabled_reason === "quota" || route.disabled_reason === "setup";
                    return (
                      <Notice key={route.key} tone={account ? "err" : "warn"}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <span className="font-medium text-ink">
                              {toolLabel[route.tool]}：{healthLabel(route)}
                            </span>
                            <p className="mt-0.5">
                              {route.disabled_reason === "auth"
                                ? "接口拒绝了该密钥，网关已停止向其发送请求。更换密钥后自动恢复；确认密钥有效时也可直接重新启用。"
                                : route.disabled_reason === "quota"
                                  ? route.disabled_ms > 0
                                    ? "接口报告额度已用尽并给出了重置时间，届时自动恢复。充值后可直接重新启用。"
                                    : "接口报告额度已用尽，网关已停止向其发送请求。充值后可在此重新启用。"
                                  : route.disabled_reason === "setup"
                                    ? "Worker 上的 OpenCLI 用不了所选的 Chrome Profile，网关已停止向其发送请求。在下方重新选择 Profile 后自动恢复；Worker 重新报告该 Profile 时也会自动恢复。"
                                    : "短时间内连续失败，暂时跳过，冷却后自动重试。"}
                            </p>
                            {route.disabled_detail && <p className="num mt-1 break-all text-ink-3">{route.disabled_detail}</p>}
                          </div>
                          <Reenable id={route.key} />
                        </div>
                      </Notice>
                    );
                  })}
                </div>
              )}

              {info.worker ? (
                <WorkerRows creds={creds} set={set} worker={status?.worker} publicUrl={config.network.public_url} />
              ) : (
                <CardRow
                  label="API Key"
                  aside={!info.key_required && "可选"}
                >
                  <SecretInput
                    value={creds}
                    placeholder={info.key_required ? "粘贴 API Key" : "留空亦可使用，填写后额度更高"}
                    onChange={(next) => update((d) => void (d.providers[info.id] = next))}
                  />
                </CardRow>
              )}

              <CardRow
                label="配额限流"
                aside={
                  tools.length > 1 && (
                    <Tooltip content={`${tools.map((tool) => toolLabel[tool]).join("、")}的调用合并计数`}>
                      <div className="cursor-help text-2xs text-ink-3 underline decoration-line-strong decoration-dotted underline-offset-2">
                        {tools.length} 工具共用
                      </div>
                    </Tooltip>
                  )
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <RateLimitInput value={creds.rate_limit} fallback={info.default_rate_limit} onChange={(rate_limit) => set((p) => (p.rate_limit = rate_limit))} />
                  <div className="flex items-center gap-1.5 text-xs text-ink-3">
                    <span>并发</span>
                    <NumberInput
                      className="w-20"
                      min={0}
                      suffix={creds.concurrency === 0 ? "不限" : undefined}
                      value={creds.concurrency}
                      onChange={(concurrency) => set((p) => (p.concurrency = Math.max(0, Math.round(concurrency))))}
                      aria-label={`${info.name} 并发上限`}
                    />
                  </div>
                </div>
              </CardRow>

              {!info.worker && (
                <CardRow label="接口地址" aside={creds.base_url && <div className="text-2xs text-signal-text">已自定义</div>}>
                  <div className="flex items-center gap-2">
                    <Input
                      mono
                      value={creds.base_url ?? ""}
                      placeholder={defaultUrl}
                      aria-label={`${info.name} 接口地址`}
                      onChange={(e) => set((p) => (p.base_url = e.target.value.trim() || undefined))}
                    />
                    {creds.base_url && (
                      <Button size="sm" variant="ghost" onClick={() => set((p) => (p.base_url = undefined))}>
                        恢复默认
                      </Button>
                    )}
                  </div>
                </CardRow>
              )}
            </Panel>
          );
        })}
      </div>
    </>
  );
}

/** One setting of a provider card: its name on the left, the control on the right. */
function CardRow({ label, aside, children }: { label: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[4.5rem_1fr]">
      <div className="flex items-center justify-between sm:block">
        <div className="text-xs font-medium text-ink-2">{label}</div>
        {typeof aside === "string" ? <div className="text-2xs text-ink-3">{aside}</div> : aside}
      </div>
      {children}
    </div>
  );
}

/** The sites a provider reads through adapters of its own, when a routing rule sends them to it. */
function Adapters({ ids }: { ids: string[] }) {
  const { meta } = useConfig();
  return (
    <Popover
      align="end"
      className="w-72"
      trigger={
        <Button size="sm" variant="ghost" icon={<Puzzle />}>
          能力
        </Button>
      }
    >
      <div className="p-3.5">
        <div className="text-xs font-medium text-ink">专属适配器</div>
        <p className="mt-1 text-xs text-ink-3">
          服务路由把这些站点的帖子交给它时，用站点适配器读取正文与完整的评论回复；其他页面，以及抓取路由中的兜底，按页面渲染结果读取。
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          {ids.map((id) => {
            const rule = meta.rules.find((r) => r.id === id);
            return (
              <Link key={id} href="/routing/rules" className="flex items-center gap-2 rounded-ctl px-2 py-1.5 text-sm text-ink-2 transition-colors hover:bg-sunken hover:text-ink">
                <BrandIcon id={id} className="size-3.5" />
                <span>{rule?.name ?? id}</span>
                <span className="num ml-auto truncate text-2xs text-ink-3">{rule?.match.join(" ")}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </Popover>
  );
}

function WorkerBadge({ worker }: { worker?: WorkerStatus }) {
  if (!worker?.connected)
    return (
      <Badge tone="warn" dot>
        Worker 离线
      </Badge>
    );
  if (!worker.state?.ready)
    return (
      <Badge tone="warn" dot>
        浏览器未就绪
      </Badge>
    );
  return (
    <Badge tone="ok" dot>
      在线
    </Badge>
  );
}

/** A token a worker can present: 32 random bytes, URL-safe. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "smw_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The settings of a provider served by the worker: its token, its state and the profile it reads with. */
function WorkerRows({
  creds,
  set,
  worker,
  publicUrl,
}: {
  creds: Provider;
  set: (change: (p: Provider) => void) => void;
  worker?: WorkerStatus;
  publicUrl?: string;
}) {
  // A generated token is shown in the command until the page is left; the
  // saved one comes back only as a hint.
  const [fresh, setFresh] = useState<string>();
  const token = creds.api_key || fresh;
  const hasToken = Boolean(creds.api_key || (creds.api_key_hint && !creds.clear_api_key));
  const server = publicUrl || window.location.origin;
  const command = `npx seekmux --server ${server} --token ${token ?? "<Worker 令牌>"}`;
  const state = worker?.connected ? worker.state : undefined;
  const profiles = state?.profiles ?? [];
  const chosen = creds.profile ?? "";
  const unknown = Boolean(chosen && worker?.connected && !profiles.some((p) => p.id === chosen));

  return (
    <>
      <CardRow label="Worker 令牌">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SecretInput
              value={creds}
              placeholder="生成或粘贴一个令牌"
              onChange={(next) =>
                set((p) => {
                  p.api_key = next.api_key;
                  p.clear_api_key = next.clear_api_key;
                })
              }
            />
          </div>
          {!creds.api_key && (
            <Button
              icon={<RefreshCw />}
              title={hasToken ? "重新生成令牌，已连接的 Worker 需换用新令牌" : undefined}
              aria-label={hasToken ? "重新生成令牌" : undefined}
              onClick={() => {
                const value = newToken();
                setFresh(value);
                set((p) => {
                  p.api_key = value;
                  p.clear_api_key = false;
                });
              }}
            >
              {hasToken ? null : "生成"}
            </Button>
          )}
        </div>
      </CardRow>

      <CardRow label="Worker">
        {!hasToken ? (
          <span className="text-xs text-ink-3">先生成令牌，再在装有 Chrome 和 OpenCLI 扩展的设备上运行 Worker。</span>
        ) : worker?.connected ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
              <span className="num">{worker.addr}</span>
              <span className="text-ink-3">seekmux {worker.version}</span>
              {state?.opencli && <span className="text-ink-3">OpenCLI {state.opencli}</span>}
              <span className="text-ink-3">
                任务 <span className="num text-ink-2">{worker.active}</span>/{worker.slots}
              </span>
            </div>
            {!state?.ready && <span className="text-xs text-warn">浏览器未就绪：{state?.problem ?? "未知原因"}</span>}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-ink-3">未连接。在装有 Chrome 和 OpenCLI 扩展的设备上运行：</span>
            <CodeBlock copy wrap>
              {command}
            </CodeBlock>
            {!token && <span className="text-2xs text-ink-3">已保存的令牌不再显示；忘记时可重新生成，旧 Worker 随之失效。</span>}
          </div>
        )}
      </CardRow>

      <CardRow label="Profile">
        <div className="flex flex-col gap-1.5">
          <Select value={chosen} onChange={(e) => set((p) => (p.profile = e.target.value || undefined))} aria-label="Chrome Profile">
            <option value="">OpenCLI 默认</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.alias ? `${p.alias}（${p.id}）` : p.id}
                {p.connected ? "" : " · 未打开"}
                {p.default ? " · 默认" : ""}
              </option>
            ))}
            {chosen && !profiles.some((p) => p.id === chosen) && <option value={chosen}>{chosen}{worker?.connected ? " · Worker 上不存在" : ""}</option>}
          </Select>
          <span className={unknown ? "text-xs text-err" : "text-xs text-ink-3"}>
            {unknown
              ? "Worker 上的 OpenCLI 不认识这个 Profile，抓取会被熔断。"
              : "建议为 Worker 单独准备一个已登录目标站点的 Chrome Profile。连接了多个 Profile 时必须选择一个。"}
          </span>
        </div>
      </CardRow>
    </>
  );
}
