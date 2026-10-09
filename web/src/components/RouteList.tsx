import { ArrowDown, ArrowUp } from "lucide-react";
import { Link } from "wouter";
import type { Route, Tool } from "../lib/api";
import { useConfig } from "../lib/config";
import { Tripped, useStatus } from "./Health";
import { RateLimitInput } from "../ui/inputs";
import { Badge, Button, cx, NumberInput, Switch, Tooltip } from "../ui/primitives";

/**
 * The priority lanes of a tool: one provider per lane, tried from the top.
 * Each lane carries the limits of that provider for this tool.
 */
export function RouteList({ tool }: { tool: Extract<Tool, "search" | "fetch"> }) {
  const { config, update, provider } = useConfig();
  const routes = config[tool].routes;
  const status = useStatus();

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
        const creds = config.providers[route.provider];
        const hasKey = Boolean(creds?.api_key || (creds?.api_key_hint && !creds.clear_api_key));
        const missingKey = info.key_required && !hasKey;
        const live = route.enabled && !missingKey;
        const health = status?.routes.find((r) => r.key === `${route.provider}:${tool}`);
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
                {info.name}
                {missingKey ? (
                  <Link href="/providers">
                    <Badge tone="warn" dot>
                      缺少密钥
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
              </div>
              <div className="tag mt-0.5 normal-case">{creds?.base_url || info.default_base_url[tool]}</div>
            </div>
            <label className="flex flex-col gap-1">
              <span className="tag">限流</span>
              <RateLimitInput value={route.rate_limit} fallback={info.default_rate_limit[tool]} onChange={(rate_limit) => edit(index, { rate_limit })} />
            </label>
            <label className="flex flex-col gap-1">
              <Tooltip content="同时进行的请求数上限，0 为不限">
                <span className="tag">并发</span>
              </Tooltip>
              <NumberInput className="w-16" value={route.concurrency} onChange={(concurrency) => edit(index, { concurrency: Math.round(concurrency) })} aria-label="并发上限" />
            </label>
            <Switch checked={route.enabled} onCheckedChange={(enabled) => edit(index, { enabled })} aria-label={`启用 ${info.name}`} />
          </li>
        );
      })}
    </ol>
  );
}
