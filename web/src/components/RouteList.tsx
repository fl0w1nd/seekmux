import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type { Route, RoutedTool } from "../lib/api";
import { useConfig } from "../lib/config";
import { toolLabel } from "../lib/format";
import { Tripped, useStatus } from "./Health";
import { customized, RouteOptions } from "./RouteOptions";
import { Badge, Button, cx, Switch, Tooltip } from "../ui/primitives";

/**
 * The priority lanes of a tool: one provider per lane, tried from the top.
 * Each lane shows the limits of its provider, which are set on the providers
 * page and shared by every tool it serves, and opens to the provider's
 * parameters for this tool.
 */
export function RouteList({ tool }: { tool: RoutedTool }) {
  const { config, update, provider } = useConfig();
  const routes = config[tool].routes;
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
        const creds = config.providers[route.provider];
        const hasKey = Boolean(creds?.api_key || (creds?.api_key_hint && !creds.clear_api_key));
        const missingKey = info.key_required && !hasKey;
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
            <Tooltip content={shared.length > 0 ? `提供商级限流，与${shared.map((t) => toolLabel[t]).join("、")}合并计数。在「提供商」页设置` : "提供商级限流，在「提供商」页设置"}>
              <Link href="/providers" className="flex flex-col gap-1 text-right hover:text-ink">
                <span className="tag">限流{shared.length > 0 && " · 共用"}</span>
                <span className="num text-xs text-ink-2">
                  {creds?.rate_limit || "不限"}
                  {creds?.concurrency ? ` · 并发 ${creds.concurrency}` : ""}
                </span>
              </Link>
            </Tooltip>
            <Button
              size="sm"
              variant={open === route.provider ? "secondary" : "ghost"}
              icon={<SlidersHorizontal />}
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
