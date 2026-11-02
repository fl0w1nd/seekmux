import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { healthLabel, Reenable, useStatus } from "../components/Health";
import { useConfig } from "../lib/config";
import { toolLabel } from "../lib/format";
import { PageHeader } from "../Shell";
import { BrandIcon } from "../ui/brand";
import { RateLimitInput, SecretInput } from "../ui/inputs";
import { Badge, Button, Input, Notice, NumberInput, Panel, Tooltip } from "../ui/primitives";

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
          const defaultUrl = Object.values(info.default_base_url)[0];

          const stateBadge = hasAuthErr ? (
            <Badge tone="err" dot>
              密钥被拒
            </Badge>
          ) : hasQuotaErr ? (
            <Badge tone="err" dot>
              额度用尽
            </Badge>
          ) : off.length > 0 ? (
            <Badge tone="warn" dot>
              已熔断
            </Badge>
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
                  <a
                    href={info.website}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-1 inline-flex items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink"
                  >
                    控制台 <ExternalLink className="size-3" />
                  </a>
                </>
              }
            >
              {off.length > 0 && (
                <div className="flex flex-col gap-2 border-b border-line p-3.5">
                  {off.map((route) => {
                    const account = route.disabled_reason === "auth" || route.disabled_reason === "quota";
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

              <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 sm:grid-cols-[4.5rem_1fr]">
                <div className="flex items-center justify-between sm:block">
                  <div className="text-xs font-medium text-ink-2">API Key</div>
                  {!info.key_required && <div className="text-2xs text-ink-3">可选</div>}
                </div>
                <SecretInput
                  value={creds}
                  placeholder={info.key_required ? "粘贴 API Key" : "留空亦可使用，填写后额度更高"}
                  onChange={(next) => update((d) => void (d.providers[info.id] = next))}
                />
              </div>

              <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 sm:grid-cols-[4.5rem_1fr]">
                <div className="flex items-center justify-between sm:block">
                  <div className="text-xs font-medium text-ink-2">配额限流</div>
                  {tools.length > 1 && (
                    <Tooltip content={`${tools.map((tool) => toolLabel[tool]).join("、")}的调用合并计数`}>
                      <div className="cursor-help text-2xs text-ink-3 underline decoration-line-strong decoration-dotted underline-offset-2">
                        {tools.length} 工具共用
                      </div>
                    </Tooltip>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <RateLimitInput
                    value={creds.rate_limit}
                    fallback={info.default_rate_limit}
                    onChange={(rate_limit) => update((d) => void (d.providers[info.id].rate_limit = rate_limit))}
                  />
                  <div className="flex items-center gap-1.5 text-xs text-ink-3">
                    <span>并发</span>
                    <NumberInput
                      className="w-20"
                      min={0}
                      suffix={creds.concurrency === 0 ? "不限" : undefined}
                      value={creds.concurrency}
                      onChange={(concurrency) => update((d) => void (d.providers[info.id].concurrency = Math.max(0, Math.round(concurrency))))}
                      aria-label={`${info.name} 并发上限`}
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[4.5rem_1fr]">
                <div className="flex items-center justify-between sm:block">
                  <div className="text-xs font-medium text-ink-2">接口地址</div>
                  {creds.base_url && <div className="text-2xs text-signal-text">已自定义</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    mono
                    value={creds.base_url ?? ""}
                    placeholder={defaultUrl}
                    aria-label={`${info.name} 接口地址`}
                    onChange={(e) => update((d) => void (d.providers[info.id].base_url = e.target.value.trim() || undefined))}
                  />
                  {creds.base_url && (
                    <Button size="sm" variant="ghost" onClick={() => update((d) => void (d.providers[info.id].base_url = undefined))}>
                      恢复默认
                    </Button>
                  )}
                </div>
              </div>

              {info.capabilities && info.capabilities.length > 0 && (
                <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 rounded-b-panel bg-sunken/45 px-4 py-2.5 sm:grid-cols-[4.5rem_1fr]">
                  <div className="text-xs text-ink-3">专有抓取</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {info.capabilities.map((capability) => (
                      <Tooltip
                        key={capability.id}
                        content={`该提供商能读出 ${capability.name} 页面的专有内容。在服务路由中开启对应规则后，这类页面只交给它抓取`}
                      >
                        <Link href="/routing/rules">
                          <Badge tone="info">
                            <BrandIcon id={capability.id} className="size-3" />
                            {capability.name}
                          </Badge>
                        </Link>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              )}
            </Panel>
          );
        })}
      </div>
    </>
  );
}
