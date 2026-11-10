import type { ProviderInfo } from "../lib/api";
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

/** The providers that answered a call, such as `brave,exa` for a search whose queries went to two. */
export function ProviderNames({ ids, kind }: { ids: string; kind?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {ids.split(",").map((id) => (
        <ProviderName key={id} id={id} kind={kind} />
      ))}
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
