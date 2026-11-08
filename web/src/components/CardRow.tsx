import type { ReactNode } from "react";

/** One setting of a provider: its name on the left, the control on the right. */
export function CardRow({ label, aside, children }: { label: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[4.5rem_1fr]">
      <div className="flex items-center justify-between sm:block">
        <div className="text-xs font-medium text-ink-2">{label}</div>
        {typeof aside === "string" ? <div className="text-2xs text-ink-3">{aside}</div> : aside}
      </div>
      {children}
    </div>
  );
}
