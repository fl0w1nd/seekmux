import type { ReactNode } from "react";
import { Link } from "wouter";
import type { Route, Tool } from "../lib/api";
import { useConfig } from "../lib/config";
import { optionText } from "../lib/options";
import { cx, Dot, type Tone } from "../ui/primitives";
import { healthLabel, useStatus } from "./Health";

type RoutedTool = Extract<Tool, "search" | "fetch">;

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
  const { config, provider } = useConfig();
  const status = useStatus();
  const routes = config[tool].routes.filter((r) => r.enabled);

  const rows = routes.map((route) => {
    const info = provider(route.provider);
    const creds = config.providers[route.provider];
    const hasKey = Boolean(creds?.api_key || (creds?.api_key_hint && !creds.clear_api_key));
    const health = status?.routes.find((r) => r.key === `${route.provider}:${tool}`);
    const state: { tone: Tone; label: string; usable: boolean } =
      info.key_required && !hasKey
        ? { tone: "warn", label: "缺少密钥", usable: false }
        : health?.disabled
          ? { tone: health.disabled_reason === "provider" ? "warn" : "err", label: healthLabel(health), usable: true }
          : { tone: "ok", label: "可用", usable: true };
    return { route, name: info.name, state };
  });
  const order = rows.filter((r) => r.state.usable).map((r) => r.name);

  return (
    <div role="radiogroup" aria-label="提供商" className="overflow-hidden rounded-ctl border border-line">
      <Option checked={value === "auto"} onSelect={() => onChange("auto")} title="自动" detail={order.length > 0 ? order.join(" → ") : "没有可用的提供商"} />
      {rows.map(({ route, name, state }) => {
        const changed = changes(tool, route);
        return (
          <Option
            key={route.provider}
            checked={value === route.provider}
            disabled={!state.usable}
            onSelect={() => onChange(route.provider)}
            title={name}
            status={
              <span className="flex items-center gap-1.5 text-xs text-ink-3">
                <Dot tone={state.tone} />
                {state.label}
              </span>
            }
            detail={
              value === route.provider &&
              (changed.length > 0 ? (
                <>
                  {changed.join(" · ")}
                  {" · "}
                  <Link href={`/${tool}`} className="underline underline-offset-2 hover:text-ink">
                    修改
                  </Link>
                </>
              ) : (
                "使用默认参数"
              ))
            }
          />
        );
      })}
    </div>
  );
}

function Option({
  checked,
  disabled,
  onSelect,
  title,
  status,
  detail,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  status?: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className={cx("border-b border-line last:border-b-0", checked && "bg-raised")}>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={onSelect}
        className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm hover:bg-raised/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={cx("grid size-3.5 shrink-0 place-items-center rounded-full border", checked ? "border-signal-text" : "border-line-strong")}>
          {checked && <span className="size-1.5 rounded-full bg-signal-text" />}
        </span>
        <span className={cx("shrink-0", checked && "font-medium")}>{title}</span>
        <span className="ml-auto shrink-0">{status}</span>
      </button>
      {detail && <div className="num -mt-1 truncate px-3 pb-2 pl-9 text-xs text-ink-3">{detail}</div>}
    </div>
  );
}
