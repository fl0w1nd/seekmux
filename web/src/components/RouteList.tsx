import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type { Route, RoutedTool } from "../lib/api";
import { useConfig } from "../lib/config";
import { toolLabel } from "../lib/format";
import { routingRules } from "../lib/routing";
import { BrandIcon } from "../ui/brand";
import { Badge, Button, cx, Status, Switch, Tooltip } from "../ui/primitives";
import { Tripped, useStatus } from "./Health";
import { missing } from "./ProviderName";
import { customized, RouteOptions } from "./RouteOptions";

/**
 * The priority lanes of a tool: one provider per lane, tried from the top.
 * Columns align across rows under one header strip so micro-labels are never
 * repeated on every row.
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
    <div>
      <div className="hidden h-9 items-center gap-x-3 border-b border-line px-4 sm:flex">
        <span className="tag flex-1">提供商</span>
        <span className="tag hidden md:block md:w-48 lg:w-56">接口</span>
        <span className="tag w-28 text-right">限流</span>
        {hedged && <span className="tag w-9 text-center">对冲</span>}
        <span className="tag w-16 text-center">参数</span>
        <span className="tag w-9 text-right">启用</span>
      </div>
      <ol>
        {routes.map((route, index) => {
          const info = provider(route.provider);
          const missingKey = !credentialed(route.provider);
          const fetcher = config.fetchers.find((f) => f.id === route.provider);
          // A fetcher's limits are its own, set on its page.
          const limits = fetcher ?? config.providers[route.provider];
          const home = `/providers/${route.provider}`;
          const live = route.enabled && !missingKey;
          const health = status?.routes.find((r) => r.key === `${route.provider}:${tool}`);
          const changed = customized(route);
          const shared = info.tools.filter((t) => t !== tool);
          const address = fetcher
            ? `自托管 · ${fetcher.workers.filter((w) => w.enabled).length} Worker`
            : config.providers[route.provider]?.base_url || info.default_base_url[tool];

          return (
            <li
              key={route.provider}
              className={cx("flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2 last:border-b-0", !route.enabled && "opacity-60")}
            >
              <div className="flex min-w-44 flex-1 items-center gap-2">
                <span className={cx("num w-5 shrink-0 text-xs", live ? "text-ink-2" : "text-ink-3")}>{String(index + 1).padStart(2, "0")}</span>
                <span className="flex shrink-0 flex-col">
                  <Button size="sm" variant="ghost" className="h-3.5 w-6" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)} />
                  <Button size="sm" variant="ghost" className="h-3.5 w-6" icon={<ArrowDown />} aria-label="下移" disabled={index === routes.length - 1} onClick={() => move(index, 1)} />
                </span>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium">
                  <BrandIcon id={info.fetcher ?? info.id} className="size-4 shrink-0" />
                  <span className="truncate">{info.name}</span>
                  {missingKey ? (
                    <Link href={missing(info).href}>
                      <Badge tone="warn" dot>
                        {missing(info).label}
                      </Badge>
                    </Link>
                  ) : live && health?.disabled ? (
                    <Tripped id={health.key} health={health} />
                  ) : live ? (
                    <Status tone="ok" className="font-normal">
                      可用
                    </Status>
                  ) : (
                    <span className="text-xs font-normal text-ink-3">已停用</span>
                  )}
                  {rules
                    .filter((rule) => rule.providers.includes(route.provider))
                    .map((rule) => (
                      <Tooltip key={rule.id} content={`规则「${rule.name}」命中的页面由它抓取，不受此处顺序与开关影响`}>
                        <Link href="/routing/rules">
                          <Badge tone="info">
                            {rule.builtin && <BrandIcon id={rule.id} className="size-3" />}
                            {rule.name}
                          </Badge>
                        </Link>
                      </Tooltip>
                    ))}
                </div>
              </div>

              <span className="num hidden truncate text-xs text-ink-3 md:block md:w-48 lg:w-56" title={address}>
                {address}
              </span>

              <Tooltip
                content={
                  fetcher
                    ? "所有 Worker 共用，点击修改"
                    : shared.length > 0
                      ? `与${shared.map((t) => toolLabel[t]).join("、")}共用，点击修改`
                      : "点击修改"
                }
              >
                <Link href={home} className="num flex w-28 shrink-0 items-baseline justify-end gap-1 text-right text-xs text-ink-2 hover:text-ink max-sm:ml-auto">
                  <span>
                    {limits?.rate_limit || "不限"}
                    {limits?.concurrency ? ` · ${limits.concurrency}` : ""}
                  </span>
                  {shared.length > 0 && <span className="font-sans text-2xs text-ink-3">共用</span>}
                </Link>
              </Tooltip>

              {hedged && (
                <Tooltip content={!hedging ? "慢请求对冲已关闭" : route.no_hedge ? "不参与慢请求对冲" : "参与慢请求对冲"}>
                  <span className="flex w-9 shrink-0 justify-center">
                    <Switch
                      checked={!route.no_hedge}
                      disabled={!hedging}
                      onCheckedChange={(on) => edit(index, { no_hedge: on ? undefined : true })}
                      aria-label={`${info.name} 参与慢请求对冲`}
                    />
                  </span>
                </Tooltip>
              )}

              <span className="flex w-16 shrink-0 justify-center">
                {fetcher ? (
                  <span className="text-xs text-ink-3">—</span>
                ) : (
                  <Button
                    size="sm"
                    variant={open === route.provider ? "secondary" : "ghost"}
                    icon={<SlidersHorizontal />}
                    aria-expanded={open === route.provider}
                    onClick={() => setOpen(open === route.provider ? null : route.provider)}
                  >
                    参数{changed > 0 && <span className="num text-signal-text">{changed}</span>}
                  </Button>
                )}
              </span>

              <span className="flex w-9 shrink-0 justify-end">
                <Switch checked={route.enabled} onCheckedChange={(enabled) => edit(index, { enabled })} aria-label={`启用 ${info.name}`} />
              </span>

              {open === route.provider && <RouteOptions tool={tool} index={index} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
