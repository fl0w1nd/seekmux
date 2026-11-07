import { Link } from "wouter";
import type { Route, RoutedTool } from "../lib/api";
import { useConfig } from "../lib/config";
import { toolPage } from "../lib/format";
import { optionText } from "../lib/options";
import { Choice, ChoiceList, ChoiceStatus, type Tone } from "../ui/primitives";
import { healthLabel, useStatus } from "./Health";
import { missing, ProviderIcon } from "./ProviderName";

/** The parameters of a route that differ from the provider's defaults, in words. */
function changes(tool: RoutedTool, route: Route): string[] {
  const list = Object.entries(route.options ?? {}).map(([key, value]) => `${optionText(route.provider, tool, key).label} ${String(value)}`);
  if (route.extra_body) list.push(`附加字段 ${Object.keys(route.extra_body).length} 项`);
  return list;
}

/**
 * Chooses which provider serves a call: `auto` follows the route priority,
 * a provider name pins the call to it. The same choice the `search_engine`
 * and `fetch_engine` arguments of the MCP tools make.
 */
export function ProviderPicker({ tool, value, onChange }: { tool: RoutedTool; value: string; onChange: (value: string) => void }) {
  const { config, provider, credentialed } = useConfig();
  const status = useStatus();
  const routes = config[tool].routes.filter((r) => r.enabled);

  const rows = routes.map((route) => {
    const info = provider(route.provider);
    const health = status?.routes.find((r) => r.key === `${route.provider}:${tool}`);
    const state: { tone: Tone; label: string; usable: boolean } =
      !credentialed(route.provider)
        ? { tone: "warn", label: missing(info).label, usable: false }
        : health?.disabled
          ? { tone: health.disabled_reason === "provider" ? "warn" : "err", label: healthLabel(health), usable: true }
          : { tone: "ok", label: "可用", usable: true };
    return { route, name: info.name, state };
  });
  const order = rows.filter((r) => r.state.usable).map((r) => r.name);

  return (
    <ChoiceList label="提供商">
      <Choice checked={value === "auto"} onSelect={() => onChange("auto")} title="自动" detail={order.length > 0 ? order.join(" → ") : "没有可用的提供商"} />
      {rows.map(({ route, name, state }) => {
        const changed = changes(tool, route);
        return (
          <Choice
            key={route.provider}
            checked={value === route.provider}
            disabled={!state.usable}
            onSelect={() => onChange(route.provider)}
            title={
              <span className="flex items-center gap-2">
                <ProviderIcon id={route.provider} className="size-4" />
                {name}
              </span>
            }
            status={<ChoiceStatus tone={state.tone}>{state.label}</ChoiceStatus>}
            detail={
              value === route.provider &&
              (changed.length > 0 ? (
                <span className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                  <span>{changed.join(" · ")}</span>
                  <Link href={toolPage(tool)} className="shrink-0 font-sans underline underline-offset-2 hover:text-ink">
                    修改
                  </Link>
                </span>
              ) : (
                "使用默认参数"
              ))
            }
          />
        );
      })}
    </ChoiceList>
  );
}
