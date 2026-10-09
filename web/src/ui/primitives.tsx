import { clsx, type ClassValue } from "clsx";
import { Check, ChevronRight, Copy, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { Collapsible as RadixCollapsible, Switch as RadixSwitch, Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import {
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export const cx = (...values: ClassValue[]) => clsx(values);

/* ---------- Button ---------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-signal text-signal-ink font-medium hover:bg-signal-hover",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-raised",
  ghost: "text-ink-2 hover:bg-raised hover:text-ink",
  danger: "border border-err/40 text-err hover:bg-err/10",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: ReactNode;
  loading?: boolean;
}

export function Button({ variant = "secondary", size = "md", icon, loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-ctl whitespace-nowrap transition-colors",
        "disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0",
        size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm",
        !children && (size === "sm" ? "w-7 px-0" : "w-8 px-0"),
        buttonVariants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

/* ---------- Form controls ---------- */

/** Controls fill their container unless the caller sets a width. */
const fill = (className?: string) => !/(^|\s)w-/.test(className ?? "") && "w-full";

const control =
  "rounded-ctl border border-line bg-sunken px-2.5 text-sm text-ink placeholder:text-ink-3 transition-colors " +
  "hover:border-line-strong focus:border-signal-text focus:outline-none disabled:opacity-50 aria-[invalid=true]:border-err";

export function Input({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={cx(control, fill(className), "h-8", mono && "num", className)} spellCheck={false} autoComplete="off" {...rest} />;
}

/** A secret field with a toggle to show what was typed or pasted. */
export function PasswordInput({ className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { mono?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className={cx("relative", fill(className), className)}>
      <Input {...rest} type={shown ? "text" : "password"} className="pr-8" />
      <button
        type="button"
        tabIndex={-1}
        aria-label={shown ? "隐藏" : "显示"}
        aria-pressed={shown}
        // Keep the focus, and with it the caret, in the field.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((s) => !s)}
        className="absolute inset-y-0 right-0 grid w-8 place-items-center text-ink-3 hover:text-ink [&>svg]:size-3.5"
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}

export function Textarea({ className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cx(control, fill(className), "min-h-24 resize-y py-2 leading-5", mono && "num text-xs", className)} spellCheck={false} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        control,
        fill(className),
        "h-8 appearance-none bg-[length:10px] bg-[position:right_0.6rem_center] bg-no-repeat pr-7",
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 10 6%22><path d=%22M1 1l4 4 4-4%22 fill=%22none%22 stroke=%22%23808a80%22 stroke-width=%221.5%22 stroke-linecap=%22round%22/></svg>')]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/** A number field that keeps what is typed and reports a number only when it is one. */
export function NumberInput({
  value,
  onChange,
  min = 0,
  suffix,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className={cx("relative", className)}>
      <Input
        mono
        inputMode="decimal"
        value={text ?? String(value)}
        className={cx(suffix && "pr-10")}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(parsed) && parsed >= Number(min)) onChange(parsed);
        }}
        onBlur={() => setText(null)}
        {...rest}
      />
      {suffix && <span className="tag pointer-events-none absolute inset-y-0 right-2.5 flex items-center normal-case">{suffix}</span>}
    </div>
  );
}

export function Switch(props: ComponentProps<typeof RadixSwitch.Root>) {
  return (
    <RadixSwitch.Root
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full border border-line-strong bg-sunken transition-colors",
        "data-[state=checked]:border-signal data-[state=checked]:bg-signal disabled:opacity-45",
      )}
      {...props}
    >
      <RadixSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-ink-3 transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-signal-ink" />
    </RadixSwitch.Root>
  );
}

/** A small set of mutually exclusive options shown side by side. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  stretch,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
  size?: "sm" | "md";
  /** Fills the container, the options sharing its width. */
  stretch?: boolean;
}) {
  return (
    <div role="radiogroup" className={cx("rounded-ctl border border-line bg-sunken p-0.5", stretch ? "flex w-full" : "inline-flex")}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-[3px] px-2.5 whitespace-nowrap transition-colors [&_svg]:size-3.5",
            stretch && "flex-1 justify-center",
            size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
            option.value === value ? "bg-raised text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]" : "text-ink-3 hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("flex cursor-default flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="text-xs text-err">{error}</span> : hint ? <span className="text-xs text-ink-3">{hint}</span> : null}
    </label>
  );
}

/* ---------- Status ---------- */

export type Tone = "neutral" | "signal" | "ok" | "warn" | "err" | "info";

const toneText: Record<Tone, string> = {
  neutral: "text-ink-2",
  signal: "text-signal-text",
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  info: "text-info",
};

/** The LED: a dot that carries a state. `live` makes it breathe. */
export function Dot({ tone = "neutral", live, className }: { tone?: Tone; live?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block size-1.5 shrink-0 rounded-full bg-current",
        tone === "neutral" ? "text-ink-3" : cx(toneText[tone], "shadow-[0_0_0_3px_color-mix(in_oklch,currentColor_20%,transparent)]"),
        live && "animate-pulse-dot",
        className,
      )}
    />
  );
}

export function Badge({ tone = "neutral", dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center gap-1.5 rounded-[3px] border px-1.5 font-mono text-2xs whitespace-nowrap",
        tone === "neutral" ? "border-line text-ink-2" : cx(toneText[tone], "border-current/30 bg-current/8"),
        className,
      )}
    >
      {dot && <Dot tone={tone} />}
      <span className={tone === "neutral" ? undefined : toneText[tone]}>{children}</span>
    </span>
  );
}

/* ---------- Containers ---------- */

/** The basic container: a titled block with an optional index tag and actions. */
export function Panel({
  index,
  title,
  description,
  actions,
  children,
  className,
  flush,
}: {
  index?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Lets children (tables, row lists) run edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className={cx("rounded-panel border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-baseline gap-2 text-base font-medium">
              {index && <span className="tag text-signal-text">{index}</span>}
              {title}
            </h2>
            {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? undefined : "p-4"}>{children}</div>
    </section>
  );
}

/**
 * A group that folds away. Its header always shows what the group is set to,
 * so it can stay closed and still be read.
 */
export function Section({ title, summary, defaultOpen, children }: { title: ReactNode; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <RadixCollapsible.Root defaultOpen={defaultOpen} className="group/section border-t border-line">
      <RadixCollapsible.Trigger className="flex h-10 w-full items-center gap-2 px-4 text-left text-sm hover:bg-raised/60">
        <ChevronRight className="size-3.5 shrink-0 text-ink-3 transition-transform group-data-[state=open]/section:rotate-90" />
        <span className="shrink-0 font-medium">{title}</span>
        {summary && <span className="ml-auto min-w-0 truncate text-xs text-ink-3">{summary}</span>}
      </RadixCollapsible.Trigger>
      <RadixCollapsible.Content className="flex flex-col gap-4 px-4 pt-1 pb-4">{children}</RadixCollapsible.Content>
    </RadixCollapsible.Root>
  );
}

/* ---------- Choice ---------- */

/** A short list of options read top to bottom, one of which is chosen; each row can carry a status. */
export function ChoiceList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="overflow-hidden rounded-ctl border border-line">
      {children}
    </div>
  );
}

export function Choice({
  checked,
  disabled,
  onSelect,
  title,
  mono,
  status,
  detail,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: ReactNode;
  mono?: boolean;
  status?: ReactNode;
  /** A line under the title, such as what the option stands for. */
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
        <span className={cx("min-w-0 truncate", checked && "font-medium", mono && "num")}>{title}</span>
        {status && <span className="ml-auto shrink-0">{status}</span>}
      </button>
      {detail && <div className="num -mt-1 truncate px-3 pb-2 pl-9 text-xs text-ink-3">{detail}</div>}
    </div>
  );
}

/** The status of a choice: a dot and a word. */
export function ChoiceStatus({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-3">
      <Dot tone={tone} />
      {children}
    </span>
  );
}

/* ---------- Tabs ---------- */

export function Tabs<T extends string>({ value, onChange, className, children }: { value: T; onChange: (value: T) => void; className?: string; children: ReactNode }) {
  return (
    <RadixTabs.Root value={value} onValueChange={(v) => onChange(v as T)} className={cx("flex min-h-0 flex-col", className)}>
      {children}
    </RadixTabs.Root>
  );
}

/** The tab strip of a pane; `actions` sit at its right end. */
export function TabList<T extends string>({ tabs, actions }: { tabs: { value: T; label: ReactNode; disabled?: boolean }[]; actions?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-4 border-b border-line px-4">
      <RadixTabs.List className="flex h-full items-stretch gap-4">
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            className={cx(
              "relative inline-flex items-center gap-1.5 text-sm text-ink-3 transition-colors hover:text-ink disabled:opacity-45 data-[state=active]:text-ink",
              "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full data-[state=active]:after:bg-signal-text",
            )}
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function TabPanel({ value, className, children }: { value: string; className?: string; children: ReactNode }) {
  return (
    <RadixTabs.Content value={value} className={cx("min-h-0 flex-1 focus-visible:outline-none", className)}>
      {children}
    </RadixTabs.Content>
  );
}

/** A settings row: what the setting is on the left, its control on the right. */
export function Row({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-3 last:border-b-0", className)}>
      <div className="min-w-48 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-ink-3 [&_svg]:size-5">{icon}</div>}
      <div className="text-sm text-ink-2">{title}</div>
      {children && <div className="max-w-sm text-xs text-ink-3">{children}</div>}
    </div>
  );
}

export function Notice({ tone = "info", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex gap-2.5 rounded-ctl border border-current/25 bg-current/6 px-3 py-2 text-xs", toneText[tone], className)}>
      <Dot tone={tone} className="mt-1.5" />
      <div className="min-w-0 flex-1 text-ink-2">{children}</div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx("size-4 animate-spin text-ink-3", className)} />;
}

/* ---------- Data ---------- */

/** A meter of used slots. Up to 24 slots are drawn one by one; beyond that it is a bar. */
export function Meter({ used, limit, tone = "signal" }: { used: number; limit: number; tone?: Tone }) {
  if (limit <= 0) return <span className="tag normal-case">不限</span>;
  const full = used >= limit;
  const color = full ? "bg-warn" : tone === "signal" ? "bg-signal-text" : "bg-ok";
  if (limit <= 24) {
    return (
      <span className="inline-flex gap-px" role="meter" aria-valuenow={used} aria-valuemax={limit}>
        {Array.from({ length: limit }, (_, i) => (
          <span key={i} className={cx("h-3 w-1 rounded-[1px]", i < used ? color : "bg-line")} />
        ))}
      </span>
    );
  }
  return (
    <span className="inline-block h-1.5 w-24 overflow-hidden rounded-full bg-line" role="meter" aria-valuenow={used} aria-valuemax={limit}>
      <span className={cx("block h-full rounded-full", color)} style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
    </span>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={copied ? <Check className="text-ok" /> : <Copy />}
      aria-label={label ?? "复制"}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {label}
    </Button>
  );
}

export function CodeBlock({ children, copy, className, wrap }: { children: string; copy?: boolean; className?: string; wrap?: boolean }) {
  return (
    <div className={cx("group relative rounded-ctl border border-line bg-sunken", className)}>
      <pre className={cx("num max-h-[inherit] overflow-auto p-3 text-xs leading-5 text-ink-2", wrap && "break-words whitespace-pre-wrap")}>{children}</pre>
      {copy && (
        <div className="absolute top-1.5 right-1.5 rounded-ctl bg-sunken opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={children} />
        </div>
      )}
    </div>
  );
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          className="z-50 max-w-xs animate-in rounded-ctl border border-line-strong bg-overlay px-2 py-1 text-xs text-ink-2 shadow-overlay"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

/* ---------- Table ---------- */

export const Table = ({ className, ...rest }: ComponentProps<"table">) => (
  <table className={cx("w-full border-collapse text-sm", className)} {...rest} />
);
export const Th = ({ className, ...rest }: ComponentProps<"th">) => (
  <th className={cx("tag h-8 border-b border-line px-3 text-left font-normal whitespace-nowrap first:pl-4 last:pr-4", className)} {...rest} />
);
export const Td = ({ className, ...rest }: ComponentProps<"td">) => (
  <td className={cx("h-10 border-b border-line px-3 first:pl-4 last:pr-4", className)} {...rest} />
);
