import { Globe } from "lucide-react";
import type { Meta, ProviderInfo, Rule } from "../lib/api";
import { useConfig } from "../lib/config";
import { BrandIcon } from "../ui/brand";
import { cx } from "../ui/primitives";

/**
 * A provider as the console names it: its logo and its display name. A model
 * (kind `llm`) has no logo and keeps its id, set as machine text.
 */
export function ProviderName({ id, kind, className, icon = "size-3.5" }: { id: string; kind?: string; className?: string; icon?: string }) {
  const { provider } = useConfig();
  if (kind === "llm") return <span title={id} className={cx("num min-w-0 truncate", className)}>{id}</span>;
  const name = provider(id).name;
  return (
    <span title={name} className={cx("inline-flex min-w-0 items-center gap-1.5", className)}>
      <ProviderIcon id={id} className={cx("shrink-0", icon)} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * A provider as a call's flow names it: a self-hosted fetcher by its type,
 * which is fixed, with the name the user gave it after it, muted.
 */
export function ProviderKind({ id, className, icon = "size-3.5" }: { id: string; className?: string; icon?: string }) {
  const { provider, meta } = useConfig();
  const info = provider(id);
  if (!info.fetcher) return <ProviderName id={id} className={className} icon={icon} />;
  const { type, name } = fetcherNames(meta, info);
  return (
    <span title={name ? `${type} · ${name}` : type} className={cx("inline-flex min-w-0 items-center gap-1.5", className)}>
      <BrandIcon id={info.fetcher} className={cx("shrink-0", icon)} />
      <span className="shrink-0">{type}</span>
      {name && <span className="min-w-0 truncate font-normal text-ink-3">{name}</span>}
    </span>
  );
}

/** A self-hosted fetcher's type and, when it says more, the name the user gave it. */
export function fetcherNames(meta: Meta, info: ProviderInfo): { type: string; name: string } {
  const type = meta.fetcher_types.find((t) => t.id === info.fetcher)?.name ?? info.fetcher ?? info.id;
  return { type, name: info.name !== type ? info.name : "" };
}

/**
 * The providers that answered a call, such as `brave,exa` for a search whose
 * queries went to two, named as the call's flow names them.
 */
export function ProviderNames({ ids, kind }: { ids: string; kind?: string }) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1">
      {ids.split(",").map((id) => (kind === "llm" ? <ProviderName key={id} id={id} kind={kind} /> : <ProviderKind key={id} id={id} />))}
    </span>
  );
}

/** A provider's logo; a self-hosted fetcher shows the one of its type. */
export function ProviderIcon({ id, className }: { id: string; className?: string }) {
  const { provider } = useConfig();
  return <BrandIcon id={provider(id).fetcher ?? id} className={className} />;
}

/** What a provider that cannot be called lacks, and where to set it up. */
export function missing(info: ProviderInfo): { label: string; href: string } {
  return { label: info.fetcher ? "未启用 Worker" : "缺少密钥", href: `/providers/${info.id}` };
}

/** A routing rule's mark: the site's logo for a built-in rule, a globe for one of the user's. */
export function RuleIcon({ rule, className = "size-4" }: { rule: Rule; className?: string }) {
  return rule.builtin ? <BrandIcon id={rule.id} className={cx("shrink-0", className)} /> : <Globe className={cx("shrink-0 text-ink-3", className)} />;
}
