import { useState } from "react";
import type { Secret } from "../lib/api";
import { useConfirm } from "./overlays";
import { Button, cx, NumberInput, PasswordInput, Select, Textarea } from "./primitives";

/* ---------- Rate limit ---------- */

const units = { s: "秒", m: "分钟", h: "小时" } as const;
type Unit = keyof typeof units;

function parse(value: string): { requests: number; every: number; unit: Unit } | null {
  const m = /^(\d+)\/(\d*)(s|m|h)$/.exec(value);
  return m ? { requests: Number(m[1]), every: m[2] ? Number(m[2]) : 1, unit: m[3] as Unit } : null;
}

/** Edits a rate limit such as "15/m" as "15 requests every 1 minute". Empty means unlimited. */
export function RateLimitInput({ value, onChange, fallback = "5/m" }: { value: string; onChange: (value: string) => void; fallback?: string }) {
  const limit = parse(value);
  if (!limit) {
    return (
      <div className="flex items-center gap-2">
        <span className="tag normal-case">不限</span>
        <Button size="sm" onClick={() => onChange(fallback)}>
          设置限流
        </Button>
      </div>
    );
  }
  const emit = (next: Partial<typeof limit>) => {
    const l = { ...limit, ...next };
    onChange(`${Math.max(1, Math.round(l.requests))}/${l.every > 1 ? Math.round(l.every) : ""}${l.unit}`);
  };
  return (
    <div className="flex items-center gap-1.5 text-xs text-ink-3">
      <NumberInput className="w-16" min={1} value={limit.requests} onChange={(requests) => emit({ requests })} aria-label="请求数" />
      <span>次 / 每</span>
      <NumberInput className="w-14" min={1} value={limit.every} onChange={(every) => emit({ every })} aria-label="时间窗口" />
      <Select className="w-20" value={limit.unit} onChange={(e) => emit({ unit: e.target.value as Unit })} aria-label="时间单位">
        {Object.entries(units).map(([unit, label]) => (
          <option key={unit} value={unit}>
            {label}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="ghost" onClick={() => onChange("")}>
        不限
      </Button>
    </div>
  );
}

/* ---------- Secret ---------- */

/**
 * Edits a stored secret. The server sends only a hint of the stored key; an
 * empty value keeps it and `clear_api_key` removes it. What is typed can be
 * shown, the stored key cannot.
 */
export function SecretInput<T extends Secret>({ value, onChange, placeholder }: { value: T; onChange: (value: T) => void; placeholder?: string }) {
  const stored = Boolean(value.api_key_hint) && !value.clear_api_key;
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();

  if (stored && !editing && !value.api_key) {
    return (
      <div className="flex items-center gap-2">
        <span className="num flex h-8 flex-1 items-center rounded-ctl border border-line bg-sunken px-2.5 text-sm text-ink-2">{value.api_key_hint}</span>
        <Button onClick={() => setEditing(true)}>更换</Button>
        <Button
          variant="ghost"
          onClick={async () => {
            if (await confirm({ title: "清除该密钥？", body: "清除后立即生效，恢复需重新填入密钥。", confirm: "清除", danger: true })) onChange({ ...value, api_key: "", clear_api_key: true });
          }}
        >
          清除
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <PasswordInput
        mono
        autoComplete="new-password"
        autoFocus={editing}
        value={value.api_key}
        placeholder={placeholder ?? "粘贴 API key"}
        onChange={(e) => onChange({ ...value, api_key: e.target.value.trim(), clear_api_key: false })}
        onBlur={() => !value.api_key && setEditing(false)}
      />
      {editing && value.api_key_hint && (
        <Button
          variant="ghost"
          onClick={() => {
            setEditing(false);
            onChange({ ...value, api_key: "", clear_api_key: false });
          }}
        >
          撤销
        </Button>
      )}
    </div>
  );
}

/* ---------- Chips ---------- */

/**
 * Edits a short list of words, such as domains. Enter, a comma, a space or
 * leaving the field adds what was typed; a paste is split the same way.
 */
export function ChipInput({
  value,
  onChange,
  placeholder,
  max,
  normalize = (item) => item,
  "aria-label": label,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  max?: number;
  normalize?: (item: string) => string;
  "aria-label"?: string;
}) {
  const [text, setText] = useState("");
  const full = max !== undefined && value.length >= max;
  const add = (raw: string) => {
    const next = [...value];
    for (const part of raw.split(/[\s,，]+/)) {
      const item = normalize(part.trim());
      if (item && !next.includes(item) && (max === undefined || next.length < max)) next.push(item);
    }
    if (next.length !== value.length) onChange(next);
    setText("");
  };
  return (
    <div
      className={cx(
        "flex min-h-8 w-full flex-wrap items-center gap-1 rounded-ctl border border-line bg-sunken px-1 py-1 transition-colors",
        "focus-within:border-signal-text hover:border-line-strong",
      )}
    >
      {value.map((item) => (
        <span key={item} className="num inline-flex h-6 items-center gap-1 rounded-[3px] border border-line-strong bg-surface pr-0.5 pl-1.5 text-xs text-ink">
          {item}
          <button
            type="button"
            aria-label={`移除 ${item}`}
            className="grid size-4 place-items-center rounded-[2px] text-ink-3 hover:bg-raised hover:text-ink"
            onClick={() => onChange(value.filter((v) => v !== item))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="num h-6 min-w-24 flex-1 bg-transparent px-1.5 text-sm text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50"
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        value={text}
        disabled={full}
        placeholder={full ? `最多 ${max} 个` : value.length === 0 ? placeholder : undefined}
        onChange={(e) => (/[\s,，]/.test(e.target.value) ? add(e.target.value) : setText(e.target.value))}
        onBlur={() => text && add(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text) {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

/* ---------- JSON ---------- */

/** Edits a JSON object as text; only a valid object (or nothing) is reported. */
export function JSONInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (value: Record<string, unknown> | undefined) => void;
  placeholder?: string;
  className?: string;
}) {
  const format = (v: Record<string, unknown> | undefined) => (v && Object.keys(v).length > 0 ? JSON.stringify(v, null, 2) : "");
  const [text, setText] = useState(() => format(value));
  const [error, setError] = useState("");
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <Textarea
        mono
        rows={4}
        value={text}
        placeholder={placeholder}
        aria-invalid={error !== ""}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (next.trim() === "") {
            setError("");
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(next);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
            setError("");
            onChange(parsed as Record<string, unknown>);
          } catch {
            setError("须为 JSON 对象；修正前不会保存此处的改动");
          }
        }}
      />
      {error && <span className="text-xs text-err">{error}</span>}
    </div>
  );
}
