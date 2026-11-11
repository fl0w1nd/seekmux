import { clsx, type ClassValue } from "clsx";
import { Check, ChevronDown, ChevronRight, CircleHelp, Copy, Eye, EyeOff, LoaderCircle } from "lucide-react";
import {
  Collapsible as RadixCollapsible,
  Popover as RadixPopover,
  Select as RadixSelect,
  Switch as RadixSwitch,
  Tabs as RadixTabs,
  Tooltip as RadixTooltip,
} from "radix-ui";
import {
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type InputHTMLAttributes,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

export const cx = (...values: ClassValue[]) => clsx(values);

/* ---------- Button ---------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

// Filled, not outlined: a control inside a panel must not draw a second box.
const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-signal text-signal-ink font-medium hover:bg-signal-hover",
  secondary: "bg-fill text-ink hover:bg-fill-strong",
  ghost: "text-ink-2 hover:bg-fill hover:text-ink",
  danger: "bg-err/10 text-err hover:bg-err/15",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: ReactNode;
  loading?: boolean;
}

export function Button({ variant = "secondary", size = "md", icon, loading, className, children, disabled, ...rest }: ButtonProps) {
  // A primary action that cannot be taken goes neutral, rather than a faded signal.
  const idle = disabled && !loading;
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        "press inline-flex shrink-0 items-center justify-center gap-1.5 rounded-ctl whitespace-nowrap",
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
        !children && (size === "sm" ? "w-7 px-0" : "w-8 px-0"),
        idle && variant === "primary" ? "bg-fill-strong font-medium text-ink-3" : cx(buttonVariants[variant], idle && "opacity-45"),
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** The look of a square icon-only control, for a link that acts as one. */
export const iconButton = (size: "sm" | "md" = "md") =>
  cx("press inline-grid shrink-0 place-items-center rounded-ctl text-ink-3 hover:bg-fill hover:text-ink [&_svg]:size-4", size === "sm" ? "size-7" : "size-8");

/** A square control that shows only an icon; `label` names it for assistive technology and its tooltip. */
export function IconButton({
  icon,
  label,
  size = "md",
  tooltip = true,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { icon: ReactNode; label: string; size?: "sm" | "md"; tooltip?: boolean }) {
  const button = (
    <button type="button" aria-label={label} className={cx(iconButton(size), "disabled:opacity-45", className)} {...rest}>
      {icon}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}

/* ---------- Form controls ---------- */

/** Controls fill their container unless the caller sets a width. */
const fill = (className?: string) => !/(^|\s)w-/.test(className ?? "") && "w-full";

/** A field: the brightest layer, a hairline that darkens on hover and rings on focus. */
export const field =
  "rounded-ctl border border-line-strong bg-surface text-sm text-ink placeholder:text-ink-3 transition-[border-color,box-shadow] " +
  "hover:border-ink-3/45 focus:border-signal-text focus:shadow-ring focus:outline-none disabled:opacity-50 " +
  "aria-[invalid=true]:border-err aria-[invalid=true]:focus:shadow-none";

export function Input({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={cx(field, "h-8 px-2.5", fill(className), mono && "num", className)} spellCheck={false} autoComplete="off" {...rest} />;
}

// Marks a field as none of a password manager's business (Bitwarden, 1Password, LastPass, Dashlane).
const notACredential = { autoComplete: "off", "data-bwignore": true, "data-1p-ignore": true, "data-lpignore": "true", "data-form-type": "other" };

/**
 * A secret field with a toggle to show what was typed or pasted. `plain` is
 * for a secret that is not a login credential, such as an API key: a text
 * field masked by CSS, which password managers do not offer to fill or save.
 */
export function PasswordInput({ className, plain, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { mono?: boolean; plain?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className={cx("relative", fill(className), className)}>
      {plain ? (
        <Input {...rest} {...notACredential} type="text" className={cx("pr-8", !shown && "[-webkit-text-security:disc]")} />
      ) : (
        <Input {...rest} type={shown ? "text" : "password"} className="pr-8" />
      )}
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
  return <textarea className={cx(field, "min-h-24 resize-y px-2.5 py-2 leading-5", fill(className), mono && "num text-xs", className)} spellCheck={false} {...rest} />;
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}
export interface SelectGroup {
  group: string;
  options: SelectOption[];
}

// Radix reserves the empty string for "nothing chosen"; an option worth "" travels under this name.
const none = "\u0000none";
const encode = (value: string) => (value === "" ? none : value);
const decode = (value: string) => (value === none ? "" : value);

/** One value out of a list: a field that opens the list in place, styled like every other field. */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  mono,
  size = "md",
  className,
  "aria-label": label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: (SelectOption | SelectGroup)[];
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  const item = (option: SelectOption) => (
    <RadixSelect.Item
      key={option.value}
      value={encode(option.value)}
      disabled={option.disabled}
      className={cx(
        "relative flex min-h-8 cursor-pointer items-center rounded-thumb py-1.5 pr-3 pl-7 text-sm text-ink outline-none select-none",
        "data-disabled:cursor-not-allowed data-disabled:opacity-45 data-highlighted:bg-fill",
        mono && "num",
      )}
    >
      <RadixSelect.ItemIndicator className="absolute left-2 inline-flex">
        <Check className="size-3.5 text-signal-text" />
      </RadixSelect.ItemIndicator>
      <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
    </RadixSelect.Item>
  );
  // Without an option worth "", an empty value is no choice yet, and shows the placeholder.
  const offered = options.some((entry) => ("group" in entry ? entry.options : [entry]).some((option) => option.value === ""));
  return (
    <RadixSelect.Root value={value === "" && !offered ? "" : encode(value)} onValueChange={(v) => onChange(decode(v))} disabled={disabled}>
      <RadixSelect.Trigger
        aria-label={label}
        className={cx(
          field,
          "group/select inline-flex items-center justify-between gap-1.5 pr-2 pl-2.5 text-left whitespace-nowrap data-placeholder:text-ink-3 data-[state=open]:border-signal-text data-[state=open]:shadow-ring",
          size === "sm" ? "h-7 text-xs" : "h-8",
          mono && "num",
          fill(className),
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon className="shrink-0 text-ink-3">
          <ChevronDown className="size-3.5 transition-transform group-data-[state=open]/select:rotate-180" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          collisionPadding={12}
          className={cx(
            "z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) max-w-[calc(100vw-1.5rem)] animate-in overflow-hidden",
            "rounded-panel bg-overlay shadow-overlay",
          )}
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((entry) =>
              "group" in entry ? (
                <RadixSelect.Group key={entry.group} className="not-first:mt-1 not-first:border-t not-first:border-line not-first:pt-1">
                  <RadixSelect.Label className="tag px-2 pt-1.5 pb-1">{entry.group}</RadixSelect.Label>
                  {entry.options.map(item)}
                </RadixSelect.Group>
              ) : (
                item(entry)
              ),
            )}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

/** A number field that keeps what is typed and reports a number only when it is one. */
export function NumberInput({
  value,
  onChange,
  min = 0,
  suffix,
  zero,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
  /** Shown in place of the suffix while the value is 0, e.g. "不限". */
  zero?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = zero && value === 0 ? zero : suffix;
  // Room for the suffix: CJK characters are about twice as wide as Latin ones.
  const width = shown ? [...shown].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0) : 0;
  return (
    <div className={cx("relative", className)}>
      <Input
        mono
        inputMode="decimal"
        value={text ?? String(value)}
        style={shown ? { paddingRight: `calc(${width}ch * 0.85 + 1rem)` } : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(parsed) && parsed >= Number(min)) onChange(parsed);
        }}
        onBlur={() => setText(null)}
        {...rest}
      />
      {shown && <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-ink-3">{shown}</span>}
    </div>
  );
}

export function Switch(props: ComponentProps<typeof RadixSwitch.Root>) {
  return (
    <RadixSwitch.Root
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full bg-fill-strong transition-colors hover:bg-ink-3/30",
        "data-[state=checked]:bg-signal data-[state=checked]:hover:bg-signal-hover disabled:opacity-45",
      )}
      {...props}
    >
      <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-thumb shadow-thumb transition-transform duration-200 ease-settle data-[state=checked]:translate-x-[18px]" />
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
    <div role="radiogroup" className={cx("items-stretch gap-0.5 rounded-ctl bg-fill p-0.5", size === "sm" ? "h-7" : "h-8", stretch ? "flex w-full" : "inline-flex")}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-thumb whitespace-nowrap transition-[color,background-color,box-shadow] duration-150 [&_svg]:size-3.5",
            stretch && "flex-1 justify-center",
            size === "sm" ? "px-2 text-xs" : "px-2.5 text-sm",
            option.value === value ? "bg-thumb text-ink shadow-thumb" : "text-ink-2 hover:text-ink",
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
  info,
  error,
  children,
  className,
}: {
  label: ReactNode;
  /** A short inline note: a unit, a format, a consequence that cannot be undone. */
  hint?: ReactNode;
  /** What is worth knowing but not needed to fill the field, behind an ⓘ. */
  info?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  // Not a <label>: that would hand every click on the blank space around the
  // control back to it, so the field could not be left by clicking beside it.
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className={cx("flex flex-col gap-1.5", className)}>
      <span className="flex items-center gap-1 self-start">
        <span
          id={id}
          className="text-xs font-medium text-ink-2"
          onClick={(e) =>
            e.currentTarget.closest("[role=group]")?.querySelector<HTMLElement>("input, textarea, select, button[role=combobox]")?.focus()
          }
        >
          {label}
        </span>
        {info && <Info label={infoLabel(label)}>{info}</Info>}
      </span>
      {children}
      {error ? <span className="text-xs text-err">{error}</span> : hint ? <span className="text-xs text-ink-3">{hint}</span> : null}
    </div>
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
export function Dot({ tone = "neutral", live, halo = true, className }: { tone?: Tone; live?: boolean; halo?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block size-1.5 shrink-0 rounded-full bg-current",
        tone === "neutral" ? "text-ink-3" : cx(toneText[tone], halo && "ring-3 ring-current/18"),
        live && "animate-pulse-dot",
        className,
      )}
    />
  );
}

/** A state in a dot and a word, with no box: for what is fine or neutral. */
export function Status({ tone = "neutral", live, children, className }: { tone?: Tone; live?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-2", className)}>
      <Dot tone={tone} live={live} />
      {children}
    </span>
  );
}

/**
 * A short label on a tinted ground, no border: a category, or a state that
 * needs a look. A state that is fine is a `Status`.
 */
export function Badge({ tone = "neutral", dot, mono, children, className }: { tone?: Tone; dot?: boolean; mono?: boolean; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center gap-1.5 rounded-tag px-1.5 whitespace-nowrap",
        mono ? "num text-2xs" : "text-xs font-medium",
        tone === "neutral" ? "bg-fill text-ink-2" : cx(toneText[tone], "bg-current/10"),
        className,
      )}
    >
      {dot && <Dot tone={tone} halo={false} />}
      <span className={cx("inline-flex items-center gap-1", tone !== "neutral" && toneText[tone])}>{children}</span>
    </span>
  );
}

/** A state in its weight: what is fine or neutral as a dot and a word, a problem as a tinted badge. */
export function State({ tone, live, children }: { tone: Tone; live?: boolean; children: ReactNode }) {
  return tone === "warn" || tone === "err" ? (
    <Badge tone={tone} dot>
      {children}
    </Badge>
  ) : (
    <Status tone={tone} live={live}>
      {children}
    </Status>
  );
}

/** A keyboard key, as named in a tooltip or beside an action. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx("num inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-tag bg-fill px-1 text-2xs text-ink-3 not-italic", className)}>
      {children}
    </kbd>
  );
}

/* ---------- Containers ---------- */

/** The basic container: a titled block with optional actions. */
export function Panel({
  title,
  description,
  info,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  description?: ReactNode;
  info?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Lets children (tables, row lists) run edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className={cx("rounded-panel border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="t-heading flex items-center gap-1.5">
              {title}
              {info && <Info label={infoLabel(title)}>{info}</Info>}
            </h2>
            {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
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
      <RadixCollapsible.Trigger className="flex h-11 w-full items-center gap-2 px-4 text-left text-sm transition-colors hover:bg-fill">
        <ChevronRight className="size-3.5 shrink-0 text-ink-3 transition-transform group-data-[state=open]/section:rotate-90" />
        <span className="shrink-0 font-medium">{title}</span>
        {summary && <span className="ml-auto min-w-0 truncate text-xs text-ink-3">{summary}</span>}
      </RadixCollapsible.Trigger>
      <RadixCollapsible.Content className="flex flex-col gap-4 px-4 pt-1 pb-4">{children}</RadixCollapsible.Content>
    </RadixCollapsible.Root>
  );
}

/* ---------- Choice ---------- */

/** A short list of options read top to bottom, one of which is chosen (or, `multi`, any of them); each row can carry a status. */
export function ChoiceList({ label, multi, children }: { label: string; multi?: boolean; children: ReactNode }) {
  return (
    <div role={multi ? "group" : "radiogroup"} aria-label={label} className="overflow-hidden rounded-ctl border border-line">
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
  multi,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: ReactNode;
  mono?: boolean;
  status?: ReactNode;
  /** A line under the title, such as what the option stands for. */
  detail?: ReactNode;
  /** One of several that can be chosen together: a box that ticks, and onSelect toggles it. */
  multi?: boolean;
}) {
  return (
    <div className={cx("border-b border-line transition-colors last:border-b-0", checked && "bg-fill")}>
      <button
        type="button"
        role={multi ? "checkbox" : "radio"}
        aria-checked={checked}
        disabled={disabled}
        onClick={onSelect}
        className="flex h-10 w-full items-center gap-2.5 px-3 text-left text-sm hover:bg-fill disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={cx(
            "grid size-4 shrink-0 place-items-center border transition-colors",
            multi ? "rounded-tag" : "rounded-full",
            checked ? "border-signal-text bg-signal-text" : "border-line-strong bg-surface",
          )}
        >
          {checked && (multi ? <Check className="size-3 text-surface" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-surface" />)}
        </span>
        <span className={cx("min-w-0 truncate", checked && "font-medium", mono && "num")}>{title}</span>
        {status && <span className="ml-auto shrink-0">{status}</span>}
      </button>
      {detail && <div className="num -mt-1.5 px-3 pb-2.5 pl-9.5 text-xs leading-relaxed break-words text-ink-3">{detail}</div>}
    </div>
  );
}

/** The status of a choice: a dot and a word. */
export function ChoiceStatus({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Status tone={tone} className="text-ink-3">
      {children}
    </Status>
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
export function TabList<T extends string>({ tabs, actions, flush }: { tabs: { value: T; label: ReactNode; disabled?: boolean }[]; actions?: ReactNode; flush?: boolean }) {
  return (
    <div className={cx("flex h-11 shrink-0 items-center gap-4 border-b border-line", !flush && "px-4")}>
      <RadixTabs.List className="flex h-full items-stretch gap-5">
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            className={cx(
              "relative inline-flex items-center gap-1.5 text-sm text-ink-2 transition-colors hover:text-ink disabled:opacity-45 data-[state=active]:text-ink",
              "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors data-[state=active]:after:bg-ink",
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

/** A settings row: a fixed label column on the left, its control aligned right beside it. */
export function Row({
  label,
  hint,
  info,
  align = "center",
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  info?: ReactNode;
  align?: "center" | "start";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "grid min-h-13 grid-cols-1 gap-x-4 gap-y-1.5 border-b border-line px-4 py-2.5 last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)]",
        align === "start" ? "items-start" : "items-center",
        className,
      )}
    >
      <div className={cx("flex items-center gap-1 text-sm text-ink", align === "start" && "sm:pt-1.5")}>
        {label}
        {info && <Info label={infoLabel(label)}>{info}</Info>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {children}
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
      </div>
    </div>
  );
}

/** Nothing to show: a title, and the action when there is something to do. `page` fills a pane. */
export function Empty({ icon, title, children, size = "panel" }: { icon?: ReactNode; title: string; children?: ReactNode; size?: "panel" | "page" }) {
  return (
    <div className={cx("flex flex-col items-center justify-center gap-3 px-6 text-center", size === "page" ? "min-h-72 py-16" : "py-10")}>
      {icon && <div className="grid size-10 place-items-center rounded-full bg-fill text-ink-3 [&_svg]:size-4.5">{icon}</div>}
      <div className="text-sm font-medium text-ink-2">{title}</div>
      {children && <div className="flex max-w-sm flex-wrap items-center justify-center gap-2 text-xs text-ink-3">{children}</div>}
    </div>
  );
}

/** Something wrong now, and its fix: a tinted strip, no border. */
export function Notice({ tone = "info", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex gap-2.5 rounded-ctl bg-current/8 px-3 py-2.5 text-sm", toneText[tone], className)}>
      <Dot tone={tone} halo={false} className="mt-[0.4375rem]" />
      <div className="min-w-0 flex-1 text-ink-2">{children}</div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx("size-4 animate-spin text-ink-3", className)} />;
}

/** A block the size of what is on its way; `panel` for one that stands in for a whole panel. */
export function Skeleton({ className, panel }: { className?: string; panel?: boolean }) {
  return <span aria-hidden className={cx("skeleton block", panel ? "rounded-panel" : "h-3 rounded-tag", className)} />;
}

/** Rows on their way: the shape of a list or a table while it loads. */
export function Loading({ rows = 4, className }: { rows?: number; className?: string }) {
  const widths = ["w-2/5", "w-3/5", "w-1/3", "w-1/2", "w-2/3"];
  return (
    <div role="status" aria-label="加载中" className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-4 border-b border-line px-4 last:border-b-0">
          <Skeleton className="w-16" />
          <Skeleton className={widths[i % widths.length]} />
          <Skeleton className="ml-auto w-12" />
        </div>
      ))}
    </div>
  );
}

/* ---------- Data ---------- */

/** Headline figures side by side, split by hairlines. */
export function StatGrid({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("grid gap-px overflow-hidden rounded-panel border border-line bg-line bg-clip-padding", className)}>{children}</div>;
}

/** One headline figure: a label, the value, a line of detail. */
export function Stat({ label, value, unit, detail, tone, size = "lg" }: { label: ReactNode; value: ReactNode; unit?: ReactNode; detail?: ReactNode; tone?: Tone; size?: "md" | "lg" }) {
  return (
    <div className={cx("min-w-0 bg-surface px-4", size === "lg" ? "py-3.5" : "py-3")}>
      <div className="tag truncate">{label}</div>
      <div className={cx("flex min-w-0 items-baseline gap-1.5", size === "lg" ? "mt-1" : "mt-0.5")}>
        <span className={cx("min-w-0 truncate", size === "lg" ? "num text-2xl font-medium tracking-tight" : "text-sm text-ink", tone && toneText[tone])}>{value}</span>
        {unit && <span className="shrink-0 text-xs text-ink-3">{unit}</span>}
      </div>
      {detail && <div className="mt-1 truncate text-xs text-ink-3">{detail}</div>}
    </div>
  );
}

/** How much of a limit is in use, as a bar. */
export function Meter({ used, limit, tone = "signal" }: { used: number; limit: number; tone?: Tone }) {
  if (limit <= 0) return <span className="text-xs text-ink-3">不限</span>;
  const full = used >= limit;
  const color = full ? "bg-warn" : tone === "signal" ? "bg-signal-text" : "bg-ok";
  const share = Math.min(100, (used / limit) * 100);
  return (
    <span className="inline-block h-1 w-20 overflow-hidden rounded-full bg-fill-strong" role="meter" aria-valuenow={used} aria-valuemax={limit}>
      <span className={cx("block h-full rounded-full transition-[width] duration-500 ease-settle", color)} style={{ width: `${used > 0 ? Math.max(6, share) : 0}%` }} />
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

/** Names an ⓘ after the label it explains, when the label is plain text. */
function infoLabel(label: ReactNode): string {
  return typeof label === "string" ? `${label}说明` : "说明";
}

const floating = "z-50 animate-in rounded-ctl bg-overlay text-xs text-ink-2 shadow-overlay";

/**
 * The ⓘ beside a label. It opens on hover with a mouse and on tap on a touch
 * screen, where a tooltip never opens, so anything the user needs to read can
 * live here instead of under the label.
 */
export function Info({
  children,
  label = "说明",
  className,
  trigger,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
  /** Opens on this element instead of an ⓘ, such as a disabled control whose reason it gives. */
  trigger?: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const hovered = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const hover = (inside: boolean) => (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    hovered.current = inside;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(hovered.current), inside ? 80 : 160);
  };
  return (
    <RadixPopover.Root
      open={open}
      // A click on the trigger while the mouse already opened it keeps it open.
      onOpenChange={(next) => setOpen(next || hovered.current)}
    >
      <RadixPopover.Trigger asChild onClick={(e) => e.stopPropagation()} onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
        {trigger ?? (
          <button
            type="button"
            aria-label={label}
            className={cx("inline-grid size-4 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:text-ink-2 data-[state=open]:text-ink-2", className)}
          >
            <CircleHelp className="size-3.5" />
          </button>
        )}
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side="top"
          sideOffset={6}
          collisionPadding={12}
          hideWhenDetached
          // Opening or closing on hover must not move focus: an input being edited would lose it.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={() => {
            hovered.current = false;
            setOpen(false);
          }}
          onPointerEnter={hover(true)}
          onPointerLeave={hover(false)}
          className={cx(floating, "max-w-72 px-3 py-2 leading-relaxed font-normal")}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content sideOffset={6} className={cx(floating, "max-w-xs px-2 py-1")}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

/* ---------- Table ---------- */

export const Table = ({ className, ...rest }: ComponentProps<"table">) => (
  <table className={cx("w-full border-collapse text-sm [&>tbody>tr:last-child>td]:border-b-0", className)} {...rest} />
);
export const Th = ({ className, ...rest }: ComponentProps<"th">) => (
  <th className={cx("tag h-9 border-b border-line px-3 text-left whitespace-nowrap first:pl-4 last:pr-4", className)} {...rest} />
);
export const Td = ({ className, ...rest }: ComponentProps<"td">) => (
  <td className={cx("h-11 border-b border-line px-3 py-2 first:pl-4 last:pr-4", className)} {...rest} />
);
