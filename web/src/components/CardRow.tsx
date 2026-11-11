import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import type { RoutedTool } from "../lib/api";
import { useConfig } from "../lib/config";
import { toolPage } from "../lib/format";
import { routingRules } from "../lib/routing";
import { BrandIcon } from "../ui/brand";
import { Badge } from "../ui/primitives";
import { HealthBadge, useStatus } from "./Health";
import { customized } from "./RouteOptions";

/** One setting of a provider: its name on a fixed left column, the control on the right. */
export function CardRow({ label, aside, children }: { label: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-2.5 last:border-b-0 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-start sm:justify-center sm:gap-0.5">
        <div className="text-sm text-ink">{label}</div>
        {typeof aside === "string" ? <div className="text-2xs text-ink-3">{aside}</div> : aside}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const routedTitle: Record<RoutedTool, string> = {
  search: "网页搜索",
  dev_search: "开发搜索",
  fetch: "网页抓取",
};

/** Where a provider serves in the gateway: its rank and state on each tool route and in domain rules. */
export function ProviderRoutes({ id, tools }: { id: string; tools: RoutedTool[] }) {
  const { config, meta, credentialed } = useConfig();
  const status = useStatus();
  const fetcher = config.fetchers.find((f) => f.id === id);
  const ready = fetcher ? fetcher.workers.some((w) => w.enabled) : credentialed(id);
  const rules = tools.includes("fetch") ? routingRules(config, meta).filter((r) => r.providers.includes(id)) : [];

  return (
    <div className="border-t border-line">
      <div className="tag px-4 pt-3.5 pb-1">服务归属</div>
      <ul className="divide-y divide-line">
        {tools.map((tool) => {
          const routes = config[tool].routes;
          const index = routes.findIndex((r) => r.provider === id);
          const route = index >= 0 ? routes[index] : undefined;
          const health = status?.routes.find((r) => r.key === `${id}:${tool}`);
          const changed = route ? customized(route) : 0;
          return (
            <li key={tool}>
              <Link
                href={toolPage(tool)}
                className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 text-sm transition-colors hover:bg-raised/60"
              >
                <span className="text-sm text-ink">{routedTitle[tool]}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  {!route?.enabled ? (
                    <Badge>已停用</Badge>
                  ) : (
                    <>
                      <span className="num text-xs text-ink-2">第 {index + 1} 顺位</span>
                      {!ready ? (
                        <Badge tone="warn" dot>
                          {fetcher ? "未启用 Worker" : "缺少密钥"}
                        </Badge>
                      ) : health?.disabled ? (
                        <HealthBadge health={health} />
                      ) : (
                        <Badge tone="ok" dot>
                          可用
                        </Badge>
                      )}
                      {changed > 0 && <span className="num text-xs text-ink-3">已调参 {changed} 项</span>}
                      {tool === "fetch" && config.fetch.smart_fallback && route.no_hedge && <span className="text-xs text-ink-3">不对冲</span>}
                    </>
                  )}
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-3" />
              </Link>
            </li>
          );
        })}

        {tools.includes("fetch") && (
          <li>
            <Link
              href="/routing/rules"
              className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 text-sm transition-colors hover:bg-raised/60"
            >
              <span className="text-sm text-ink">{`路由规则`}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {rules.length === 0 ? (
                  <span className="text-xs text-ink-3">未关联特定站点</span>
                ) : (
                  rules.map((rule) => (
                    <Badge key={rule.id} tone={rule.enabled ? "info" : "neutral"}>
                      {rule.builtin && <BrandIcon id={rule.id} className="size-3" />}
                      {rule.name}
                      {!rule.enabled && " · 停用"}
                    </Badge>
                  ))
                )}
              </span>
              <ChevronRight className="size-4 shrink-0 text-ink-3" />
            </Link>
          </li>
        )}
      </ul>
    </div>
  );
}
