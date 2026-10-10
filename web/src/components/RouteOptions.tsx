import { useState } from "react";
import type { ProviderOption, Route, RoutedTool } from "../lib/api";
import { useConfig } from "../lib/config";
import { extraText, optionText } from "../lib/options";
import { JSONInput } from "../ui/inputs";
import { Field, Input, Select, Switch } from "../ui/primitives";

/** How many of a route's parameters differ from the provider's defaults. */
export function customized(route: Route): number {
  return Object.keys(route.options ?? {}).length + (route.extra_body ? 1 : 0);
}

/**
 * The parameters of one provider for one tool, built from what the server
 * declares. A route keeps only the values that differ from the defaults.
 */
export function RouteOptions({ tool, index }: { tool: RoutedTool; index: number }) {
  const { config, update, provider } = useConfig();
  const route = config[tool].routes[index];
  const options = provider(route.provider).options?.[tool] ?? [];
  const extra = extraText(route.provider);

  const set = (option: ProviderOption, value: unknown) =>
    update((draft) => {
      const target = draft[tool].routes[index];
      const next = { ...target.options };
      if (value === option.default || value === undefined) delete next[option.key];
      else next[option.key] = value;
      target.options = Object.keys(next).length > 0 ? next : undefined;
    });

  return (
    <div className="flex basis-full flex-col gap-4 border-t border-line pt-3">
      {options.length > 0 && (
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {options.map((option) => {
            const text = optionText(route.provider, tool, option.key);
            const value = route.options?.[option.key] ?? option.default;
            return (
              <Field key={option.key} label={text.label} hint={text.hint}>
                <Control option={option} value={value} unit={text.unit} label={text.label} inherits={tool === "search"} onChange={(v) => set(option, v)} />
              </Field>
            );
          })}
        </div>
      )}
      <Field label={extra.label} hint="JSON 对象，原样并入发往提供商的请求；最后合并，会覆盖上方的同名设置。用于此处未列出的参数">
        <JSONInput value={route.extra_body} placeholder={extra.placeholder} onChange={(extra_body) => update((draft) => void (draft[tool].routes[index].extra_body = extra_body))} />
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
