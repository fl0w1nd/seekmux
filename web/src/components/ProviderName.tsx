import { useConfig } from "../lib/config";
import { BrandIcon } from "../ui/brand";
import { cx } from "../ui/primitives";

/**
 * A provider as the console names it: its logo and its display name. A model
 * (kind `llm`) has no logo and keeps its id, set as machine text.
 */
export function ProviderName({ id, kind, className, icon = "size-3.5" }: { id: string; kind?: string; className?: string; icon?: string }) {
  const { provider } = useConfig();
  if (kind === "llm") return <span className={cx("num min-w-0 truncate", className)}>{id}</span>;
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5", className)}>
      <BrandIcon id={id} className={cx("shrink-0", icon)} />
      <span className="truncate">{provider(id).name}</span>
    </span>
  );
}

/** The providers that answered a call, such as `brave,exa` for a search whose queries went to two. */
export function ProviderNames({ ids, kind }: { ids: string; kind?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      {ids.split(",").map((id) => (
        <ProviderName key={id} id={id} kind={kind} />
      ))}
    </span>
  );
}
