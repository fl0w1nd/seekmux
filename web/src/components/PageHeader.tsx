import type { ReactNode } from "react";

/**
 * The heading every page starts with. A page under a sidebar section names
 * the section first (`section / title`); `meta` sits beside the title (a
 * state, a badge), `description` under it and `actions` at the far end.
 */
export function PageHeader({
  title,
  section,
  meta,
  description,
  actions,
}: {
  title: ReactNode;
  section?: string;
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="t-title flex min-w-0 items-center gap-2">
            {section && (
              <>
                <span className="shrink-0 font-normal text-ink-3">{section}</span>
                <span className="shrink-0 font-normal text-ink-3/60" aria-hidden>
                  /
                </span>
              </>
            )}
            <span className="flex min-w-0 items-center gap-2 truncate">{title}</span>
          </h1>
          {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
