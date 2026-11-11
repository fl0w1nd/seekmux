import { useState } from "react";
import type { ProviderOption, Route, RoutedTool } from "../lib/api";
import { useConfig } from "../lib/config";
import { codeText } from "../lib/codes";
import { extraText, optionText } from "../lib/options";
import { CodeSelect, JSONInput } from "../ui/inputs";
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
    <div className="-mx-4 -mb-3 mt-1 basis-full border-t border-line bg-sunken/35 px-4 py-3.5">
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
  const extra = extraText(id, tool);

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
              <Field key={option.key} label={text.label} info={text.info}>
                <Control
                  option={option}
                  value={value.options?.[option.key] ?? option.default}
                  unit={text.unit}
                  label={text.label}
                  placeholder={text.placeholder}
                  inherits={tool === "search"}
                  onChange={(v) => set(option, v)}
                />
              </Field>
            );
          })}
        </div>
      )}
      <Field label={extra.label} hint="合并进请求，覆盖同名字段">
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
  placeholder,
  inherits,
  onChange,
}: {
  option: ProviderOption;
  value: unknown;
  unit?: string;
  label: string;
  placeholder?: string;
  /** Whether an empty country or language falls back to a global one. */
  inherits: boolean;
  onChange: (value: unknown) => void;
}) {
  const { config } = useConfig();
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
      if (option.format) {
        const global = inherits ? (option.format === "country" ? config.search.country : config.search.language) : undefined;
        return (
          <CodeSelect
            kind={option.format}
            value={typeof value === "string" ? value : ""}
            allowed={option.values}
            empty={inheritedText(option, global)}
            onChange={onChange}
            aria-label={label}
          />
        );
      }
      return <Input mono value={typeof value === "string" ? value : ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value.trim())} aria-label={label} />;
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
        onChange={(e) => {
          setText(e.target.value);
          const next = Number(e.target.value);
          if (e.target.value.trim() === "") onChange(typeof option.default === "number" ? option.default : undefined);
          else if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
        onBlur={() => setText(null)}
      />
      {unit && <span className="tag pointer-events-none absolute inset-y-0 right-2.5 flex h-8 items-center normal-case">{unit}</span>}
      {invalid && (
        <div className="mt-1 text-xs text-err">
          {min} – {max} 的整数
        </div>
      )}
    </div>
  );
}

/** The choice of no country or language: what the route falls back to. */
function inheritedText(option: ProviderOption, global: string | undefined): string {
  if (!global) return "不指定";
  if (option.values?.length && !option.values.includes(global)) return `不指定 · 不支持全局的 ${global}`;
  return `继承 · ${codeText(option.format!, global)}`;
}
