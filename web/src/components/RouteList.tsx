import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type { Route, RoutedTool } from "../lib/api";
import { useConfig } from "../lib/config";
import { toolLabel } from "../lib/format";
import { routingRules } from "../lib/routing";
import { Tripped, useStatus } from "./Health";
import { missing } from "./ProviderName";
import { customized, RouteOptions } from "./RouteOptions";
import { BrandIcon } from "../ui/brand";
import { Badge, Button, cx, Switch, Tooltip } from "../ui/primitives";

/**
 * The priority lanes of a tool: one provider per lane, tried from the top.
 * Each lane shows the limits of its provider, which are set on the providers
 * page and shared by every tool it serves, and opens to the provider's
 * parameters for this tool.
 */
export function RouteList({ tool }: { tool: RoutedTool }) {
  const { config, meta, update, provider, credentialed } = useConfig();
  const routes = config[tool].routes;
  // A rule keeps using its providers when their fetch route is switched off.
  const rules = tool === "fetch" ? routingRules(config, meta).filter((rule) => rule.enabled) : [];
  // Only fetch races slow requests; the switch shows on its lanes.
  const hedged = tool === "fetch";
  const hedging = hedged && config.fetch.smart_fallback;
  const status = useStatus();
  const [open, setOpen] = useState<string | null>(null);

  const edit = (index: number, change: Partial<Route>) =>
    update((draft) => {
      Object.assign(draft[tool].routes[index], change);
    });
  const move = (index: number, by: number) =>
    update((draft) => {
      const list = draft[tool].routes;
      [list[index], list[index + by]] = [list[index + by], list[index]];
    });

  return (
    <ol>
      {routes.map((route, index) => {
        const info = provider(route.provider);
        const missingKey = !credentialed(route.provider);
        const fetcher = config.fetchers.find((f) => f.id === route.provider);
        // A fetcher's limits are its own, set on its page.
        const limits = fetcher ?? config.providers[route.provider];
        const home = fetcher ? "/fetchers" : "/providers";
        const live = route.enabled && !missingKey;
        const health = status?.routes.find((r) => r.key === `${route.provider}:${tool}`);
        const changed = customized(route);
        const shared = info.tools.filter((t) => t !== tool);
        return (
          <li
            key={route.provider}
            className={cx("flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0", !route.enabled && "opacity-60")}
          >
            <span className={cx("num w-6 text-sm", live ? "text-signal-text" : "text-ink-3")}>{String(index + 1).padStart(2, "0")}</span>
            <span className="flex flex-col">
              <Button size="sm" variant="ghost" className="h-4" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)} />
              <Button size="sm" variant="ghost" className="h-4" icon={<ArrowDown />} aria-label="下移" disabled={index === routes.length - 1} onClick={() => move(index, 1)} />
            </span>
            <div className="min-w-40 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <BrandIcon id={info.fetcher ?? info.id} className="size-4" />
                {info.name}
                {missingKey ? (
                  <Link href={missing(info).href}>
                    <Badge tone="warn" dot>
                      {missing(info).label}
                    </Badge>
                  </Link>
                ) : live && health?.disabled ? (
                  <Tripped id={health.key} health={health} />
                ) : live ? (
                  <Badge tone="ok" dot>
                    可用
                  </Badge>
                ) : (
                  <Badge>已停用</Badge>
                )}
                {rules
                  .filter((rule) => rule.providers.includes(route.provider))
                  .map((rule) => (
                    <Tooltip key={rule.id} content={`服务路由规则「${rule.name}」的页面由该提供商抓取，不受此处的顺序与开关影响`}>
                      <Link href="/routing/rules">
                        <Badge tone="info">
                          {rule.builtin && <BrandIcon id={rule.id} className="size-3" />}
                          {rule.name}
                        </Badge>
                      </Link>
                    </Tooltip>
                  ))}
              </div>
              <div className="tag mt-0.5 normal-case">
                {fetcher
                  ? `自托管 · ${fetcher.workers.filter((w) => w.enabled).length} 个 Worker`
                  : config.providers[route.provider]?.base_url || info.default_base_url[tool]}
              </div>
            </div>
            <Tooltip
              content={
                fetcher
                  ? "抓取器级限流，所有 Worker 共用。在「自托管抓取器」页设置"
                  : shared.length > 0
                    ? `提供商级限流，与${shared.map((t) => toolLabel[t]).join("、")}合并计数。在「提供商」页设置`
                    : "提供商级限流，在「提供商」页设置"
              }
            >
              <Link href={home} className="flex flex-col gap-1 text-right hover:text-ink">
                <span className="tag">限流{shared.length > 0 && " · 共用"}</span>
                <span className="num text-xs text-ink-2">
                  {limits?.rate_limit || "不限"}
                  {limits?.concurrency ? ` · 并发 ${limits.concurrency}` : ""}
                </span>
              </Link>
            </Tooltip>
            {hedged && (
              <Tooltip
                content={
                  !hedging
                    ? "「行为」中的慢请求对冲已关闭，此开关暂不生效"
                    : route.no_hedge
                      ? "不参与对冲：轮到它时独自抓取，不与其他提供商并行，也不被对冲"
                      : "参与对冲：抓取过慢时与下一个提供商并行，采纳首个成功的结果"
                }
              >
                <span className="flex flex-col items-center gap-1">
                  <span className="tag">对冲</span>
                  <Switch
                    checked={!route.no_hedge}
                    disabled={!hedging}
                    onCheckedChange={(on) => edit(index, { no_hedge: on ? undefined : true })}
                    aria-label={`${info.name} 参与慢请求对冲`}
                  />
                </span>
              </Tooltip>
            )}
            {/* A fetcher takes no parameters; the space is kept so the columns line up. */}
            <Button
              size="sm"
              variant={open === route.provider ? "secondary" : "ghost"}
              icon={<SlidersHorizontal />}
              className={cx(fetcher && "invisible")}
              disabled={Boolean(fetcher)}
              aria-hidden={fetcher ? true : undefined}
              aria-expanded={open === route.provider}
              onClick={() => setOpen(open === route.provider ? null : route.provider)}
            >
              参数{changed > 0 && <span className="num text-signal-text">{changed}</span>}
            </Button>
            <Switch checked={route.enabled} onCheckedChange={(enabled) => edit(index, { enabled })} aria-label={`启用 ${info.name}`} />
            {open === route.provider && <RouteOptions tool={tool} index={index} />}
          </li>
        );
      })}
    </ol>
  );
}
