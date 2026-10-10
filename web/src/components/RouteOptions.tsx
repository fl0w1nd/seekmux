import { useState } from "react";
import type { ProviderOption, Route, RoutedTool } from "../lib/api";
import { useConfig } from "../lib/config";
import { extraText, optionText } from "../lib/options";
import { JSONInput } from "../ui/inputs";
import { cx, Field, Input, Select, Switch } from "../ui/primitives";

/** How many of a route's parameters differ from the provider's defaults. */
export function customized(route: Route): number {
  return Object.keys(route.options ?? {}).length + (route.extra_body ? 1 : 0);
}

/** The parameters of a route: what differs from the declared defaults, and the extra fields. */
export type RouteParams = Pick<Route, "options" | "extra_body">;

/**
 * The parameters of one provider for one tool, built from what the server
 * declares. A route keeps only the values that differ from the defaults.
 */
export function RouteOptions({ tool, index }: { tool: RoutedTool; index: number }) {
  const { config, update } = useConfig();
  const route = config[tool].routes[index];
  return (
    <div className="basis-full border-t border-line pt-3">
      <OptionFields
        tool={tool}
        provider={route.provider}
        value={route}
        columns="sm:grid-cols-2 lg:grid-cols-3"
        onChange={(next) => update((draft) => void Object.assign(draft[tool].routes[index], next))}
      />
    </div>
  );
}

/**
 * The controls for `value`, the parameters of `provider` for `tool`. It
 * reports the whole of them on every change.
 */
export function OptionFields({
  tool,
  provider: id,
  value,
  onChange,
  columns,
}: {
  tool: RoutedTool;
  provider: string;
  value: RouteParams;
  /** Both keys are always present, so that an emptied one overwrites what was there. */
  onChange: (value: { options: RouteParams["options"]; extra_body: RouteParams["extra_body"] }) => void;
  /** The grid columns of the declared options. */
  columns: string;
}) {
  const { provider } = useConfig();
  const options = provider(id).options?.[tool] ?? [];
  const extra = extraText(id);

  const set = (option: ProviderOption, v: unknown) => {
    const next = { ...value.options };
    if (v === option.default || v === undefined) delete next[option.key];
    else next[option.key] = v;
    onChange({ options: Object.keys(next).length > 0 ? next : undefined, extra_body: value.extra_body });
  };

  return (
    <div className="flex flex-col gap-4">
      {options.length > 0 && (
        <div className={cx("grid gap-x-4 gap-y-3", columns)}>
          {options.map((option) => {
            const text = optionText(id, tool, option.key);
            return (
              <Field key={option.key} label={text.label} hint={text.hint}>
                <Control option={option} value={value.options?.[option.key] ?? option.default} unit={text.unit} label={text.label} inherits={tool === "search"} onChange={(v) => set(option, v)} />
              </Field>
            );
          })}
        </div>
      )}
      <Field label={extra.label} hint="JSON 对象，原样并入发往提供商的请求；最后合并，会覆盖上方的同名设置。用于此处未列出的参数">
        <JSONInput value={value.extra_body} placeholder={extra.placeholder} onChange={(extra_body) => onChange({ options: value.options, extra_body })} />
      </Field>
    </div>
  );
}

function Control({
  option,
  value,
  unit,
  label,
  inherits,
  onChange,
}: {
  option: ProviderOption;
  value: unknown;
  unit?: string;
  label: string;
  /** Whether an empty country or language falls back to a global one. */
  inherits: boolean;
  onChange: (value: unknown) => void;
}) {
  switch (option.type) {
    case "bool":
      return <Switch checked={value === true} onCheckedChange={onChange} aria-label={label} />;
    case "enum":
      return (
        <Select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {option.values?.map((v) => (
            <option key={v} value={v}>
              {v === option.default ? `${v}（默认）` : v}
            </option>
          ))}
        </Select>
      );
    case "int":
      return <IntInput option={option} value={typeof value === "number" ? value : undefined} unit={unit} onChange={onChange} />;
    default:
      return (
        <Input
          mono
          value={typeof value === "string" ? value : ""}
          maxLength={option.format ? 2 : undefined}
          placeholder={option.format ? (inherits ? "继承" : "不指定") : undefined}
          onChange={(e) => {
            const next = e.target.value.trim();
            onChange(option.format === "country" ? next.toUpperCase() : option.format === "language" ? next.toLowerCase() : next);
          }}
        />
      );
  }
}

/** A whole number that may be left empty, which leaves the parameter to its default. */
function IntInput({ option, value, unit, onChange }: { option: ProviderOption; value: number | undefined; unit?: string; onChange: (value: number | undefined) => void }) {
  const [text, setText] = useState<string | null>(null);
  const min = option.min ?? 0;
  const max = option.max ?? Number.MAX_SAFE_INTEGER;
  const shown = text ?? (value === undefined ? "" : String(value));
  const parsed = Number(shown);
  const invalid = shown.trim() !== "" && !(Number.isInteger(parsed) && parsed >= min && parsed <= max);
  return (
    <div className="relative">
      <Input
        mono
        inputMode="numeric"
        value={shown}
        aria-invalid={invalid}
        className={unit ? "pr-12" : undefined}
        placeholder={typeof option.default === "number" ? String(option.default) : "不设置"}
        title={`${min} – ${max}`}
        onChange={(e) => {
          setText(e.target.value);
          const next = Number(e.target.value);
          if (e.target.value.trim() === "") onChange(typeof option.default === "number" ? option.default : undefined);
          else if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
        onBlur={() => setText(null)}
      />
      {unit && <span className="tag pointer-events-none absolute inset-y-0 right-2.5 flex items-center normal-case">{unit}</span>}
    </div>
  );
}
