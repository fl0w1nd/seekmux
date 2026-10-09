import { ExternalLink } from "lucide-react";
import { healthLabel, Reenable, useStatus } from "../components/Health";
import { useConfig } from "../lib/config";
import { toolLabel } from "../lib/format";
import { PageHeader } from "../Shell";
import { SecretInput } from "../ui/inputs";
import { Badge, Field, Input, Notice, Panel } from "../ui/primitives";

export function ProvidersPage() {
  const { config, update, meta } = useConfig();
  const status = useStatus();
  return (
    <>
      <PageHeader title="提供商" description="搜索与抓取服务的凭据。同一提供商的密钥适用于其支持的所有工具；优先级与限流在「搜索」「抓取」页按工具设置。" />
      <div className="grid gap-4 lg:grid-cols-2">
        {meta.catalog.map((info, index) => {
          const creds = config.providers[info.id];
          const tools = Object.keys(info.default_rate_limit);
          const off = status?.routes.filter((r) => r.provider === info.id && r.available && r.disabled) ?? [];
          return (
            <Panel
              key={info.id}
              index={String(index + 1).padStart(2, "0")}
              title={info.name}
              actions={
                <>
                  {tools.map((tool) => (
                    <Badge key={tool}>{toolLabel[tool]}</Badge>
                  ))}
                  <a href={info.website} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
                    控制台 <ExternalLink className="size-3" />
                  </a>
                </>
              }
            >
              <div className="flex flex-col gap-4">
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
                <Field label="API key" hint={info.key_required ? undefined : "可选：留空亦可使用，填写后额度更高"}>
                  <SecretInput value={creds} onChange={(next) => update((d) => void (d.providers[info.id] = next))} />
                </Field>
                <details className="group">
                  <summary className="tag list-none normal-case hover:text-ink-2">
                    <span className="group-open:hidden">+ 自定义接口地址</span>
                    <span className="hidden group-open:inline">− 自定义接口地址</span>
                  </summary>
                  <Field label="Base URL" hint="留空使用官方地址；自建或代理时填写" className="mt-3">
                    <Input
                      mono
                      value={creds.base_url ?? ""}
                      placeholder={Object.values(info.default_base_url)[0]}
                      onChange={(e) => update((d) => void (d.providers[info.id].base_url = e.target.value.trim() || undefined))}
                    />
                  </Field>
                </details>
              </div>
            </Panel>
          );
        })}
      </div>
    </>
  );
}
