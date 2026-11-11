import { SlidersHorizontal } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { Link } from "wouter";
import type { Route, RoutedTool, Rule } from "../lib/api";
import { useConfig } from "../lib/config";
import { toolLabel } from "../lib/format";
import { lifted, useReorder } from "../lib/reorder";
import { routingRules } from "../lib/routing";
import { BrandIcon } from "../ui/brand";
import { parseRateLimit } from "../ui/inputs";
import { Badge, cx, Dot, DragHandle, iconButton, Info, Status, Switch, Tooltip } from "../ui/primitives";
import { TrippedState, useStatus } from "./Health";
import { missing, RuleIcon } from "./ProviderName";
import { customized, RouteOptions } from "./RouteOptions";

/**
 * The priority lanes of a tool: one provider per lane, tried from the top,
 * reordered by dragging the handle. Header and rows share one grid, so every
 * column lines up; below `sm` a row puts its state on a second line.
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
  const reorder = useReorder({
    count: routes.length,
    onStart: () => setOpen(null),
    onMove: (from, to) =>
      update((draft) => {
        const list = draft[tool].routes;
        list.splice(to, 0, ...list.splice(from, 1));
      }),
  });

  // grip · number · provider · [address] · limit · state · [hedge] · switch · parameters
  const tail = ["7rem", "6.5rem", ...(hedged ? ["2.25rem"] : []), "2.25rem", "1.75rem"];
  const grid = {
    "--cols": ["1rem", "1.25rem", "minmax(0,1fr)", ...tail].join(" "),
    "--cols-lg": ["1rem", "1.25rem", "minmax(11rem,1.5fr)", "minmax(0,1fr)", ...tail].join(" "),
  } as CSSProperties;
  const columns = "sm:grid-cols-(--cols) lg:grid-cols-(--cols-lg)";

  return (
    <div style={grid}>
      <div className={cx("hidden h-9 items-center gap-x-3 border-b border-line px-4 sm:grid", columns)}>
        <span className="tag col-start-3">提供商</span>
        <span className="tag hidden lg:block">接口</span>
        <span className="tag">限流</span>
        <span className="tag">状态</span>
        {hedged && <span className="tag text-center">对冲</span>}
        <span className="tag text-center">启用</span>
      </div>
      <ol>
        {routes.map((route, index) => {
          const info = provider(route.provider);
          const missingKey = !credentialed(route.provider);
          const fetcher = config.fetchers.find((f) => f.id === route.provider);
          // A fetcher's limits are its own, set on its page.
          const limits = fetcher ?? config.providers[route.provider];
          const live = route.enabled && !missingKey;
          const health = status?.routes.find((r) => r.key === `${route.provider}:${tool}`);
          const changed = customized(route);
          const shared = info.tools.filter((t) => t !== tool);
          const address = fetcher
            ? `自托管 · ${fetcher.workers.filter((w) => w.enabled).length} Worker`
            : config.providers[route.provider]?.base_url || info.default_base_url[tool];
          const row = reorder.row(index);
          const dragged = reorder.dragging === index;
          const expanded = open === route.provider;

          return (
            <li
              key={route.provider}
              ref={row.ref}
              style={row.style}
              className={cx(
                "grid min-h-11 grid-cols-[1rem_1.25rem_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5 last:border-b-0",
                columns,
                dragged && lifted,
              )}
            >
              <DragHandle label={`拖动排序 ${info.name}`} active={dragged} {...reorder.handle(index)} />

              <span className={cx("num text-xs", live ? "text-ink-2" : "text-ink-3")}>{String(index + 1).padStart(2, "0")}</span>

              <div className={cx("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", !route.enabled && "opacity-60")}>
                <BrandIcon id={info.fetcher ?? info.id} className="size-4 shrink-0" />
                <span className="truncate text-sm font-medium">{info.name}</span>
                <RuleBadge rules={rules.filter((rule) => rule.providers.includes(route.provider))} />
              </div>

              {/* Below sm the state sits on a line of its own; from sm up its cells join the grid. */}
              <div className="col-span-3 col-start-3 row-start-2 flex flex-wrap items-center gap-x-4 gap-y-1 sm:contents">
                <span className={cx("num hidden truncate text-xs text-ink-3 lg:block", !route.enabled && "opacity-60")} title={address}>
                  {address}
                </span>

                <Tooltip
                  content={[
                    limits?.concurrency ? `并发 ${limits.concurrency}` : "",
                    fetcher ? "所有 Worker 共用" : shared.length > 0 ? `与${shared.map((t) => toolLabel[t]).join("、")}共用` : "",
                    "点击修改",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <Link href={`/providers/${route.provider}`} className={cx("group/limit flex min-w-0 items-center gap-2 text-xs max-sm:w-24", !route.enabled && "opacity-60")}>
                    <Limit rate={limits?.rate_limit ?? ""} concurrency={limits?.concurrency ?? 0} />
                    {shared.length > 0 && <span className="text-2xs text-ink-3">共用</span>}
                  </Link>
                </Tooltip>

                <span className="flex min-w-0">
                  {missingKey ? (
                    <Link href={missing(info).href} className="min-w-0">
                      <Badge tone="warn" dot>
                        {missing(info).label}
                      </Badge>
                    </Link>
                  ) : live && health?.disabled ? (
                    <TrippedState id={health.key} health={health} />
                  ) : live ? (
                    <Status tone="ok">可用</Status>
                  ) : (
                    <Status>已停用</Status>
                  )}
                </span>

                {hedged && (
                  <Tooltip content={!hedging ? "慢请求对冲已关闭" : route.no_hedge ? "不参与慢请求对冲" : "参与慢请求对冲"}>
                    <label className="flex items-center gap-1.5 text-xs text-ink-3 sm:justify-center">
                      <span className="sm:hidden">对冲</span>
                      <Switch
                        checked={!route.no_hedge}
                        disabled={!hedging}
                        onCheckedChange={(on) => edit(index, { no_hedge: on ? undefined : true })}
                        aria-label={`${info.name} 参与慢请求对冲`}
                      />
                    </label>
                  </Tooltip>
                )}
              </div>

              <span className="col-start-4 row-start-1 flex justify-center sm:col-auto sm:row-auto">
                <Switch checked={route.enabled} onCheckedChange={(enabled) => edit(index, { enabled })} aria-label={`启用 ${info.name}`} />
              </span>

              <span className="col-start-5 row-start-1 flex justify-end sm:col-auto sm:row-auto">
                {!fetcher && (
                  <Tooltip content={changed > 0 ? `参数 · 已改 ${changed} 项` : "参数"}>
                    <button
                      type="button"
                      aria-label={`${info.name} 参数`}
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : route.provider)}
                      className={cx(iconButton("sm"), "relative", expanded && "bg-fill text-ink")}
                    >
                      <SlidersHorizontal />
                      {changed > 0 && <Dot tone="signal" halo={false} className="absolute top-1 right-1" />}
                    </button>
                  </Tooltip>
                )}
              </span>

              {expanded && <RouteOptions tool={tool} index={index} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The routing rules that send their pages to a provider, folded into one
 * badge: a few of their marks and how many; the list is on the badge.
 */
function RuleBadge({ rules }: { rules: Rule[] }) {
  if (rules.length === 0) return null;
  return (
    <Info
      label={`${rules.length} 条路由规则`}
      trigger={
        <button type="button" className="press shrink-0 rounded-tag">
          <Badge>
            <span className="flex items-center gap-0.5">
              {rules.slice(0, 3).map((rule) => (
                <RuleIcon key={rule.id} rule={rule} className="size-3" />
              ))}
            </span>
            {rules.length === 1 ? rules[0].name : `${rules.length} 条规则`}
          </Badge>
        </button>
      }
    >
      <div className="flex flex-col gap-2">
        <span>命中以下规则的页面由它抓取，不受此处顺序与开关影响</span>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-1.5 text-ink">
              <RuleIcon rule={rule} className="size-3.5" />
              {rule.name}
            </li>
          ))}
        </ul>
        <Link href="/routing/rules" className="self-start text-ink-2 underline underline-offset-2 hover:text-ink">
          路由规则
        </Link>
      </div>
    </Info>
  );
}

/**
 * A rate limit set so that a column of them lines up on the slash: the count
 * right-aligned before it, the window after it, then the concurrency.
 */
function Limit({ rate, concurrency }: { rate: string; concurrency: number }) {
  const limit = parseRateLimit(rate);
  return (
    <span className="num flex items-baseline whitespace-nowrap text-ink-2 transition-colors group-hover/limit:text-ink">
      {limit ? (
        <>
          <span className="min-w-[3ch] text-right">{limit.requests}</span>
          <span>
            /{limit.every > 1 ? limit.every : ""}
            {limit.unit}
          </span>
        </>
      ) : (
        <span className="font-sans">不限</span>
      )}
      {concurrency > 0 && <span className="ml-1 text-ink-3">· {concurrency}</span>}
    </span>
  );
}
