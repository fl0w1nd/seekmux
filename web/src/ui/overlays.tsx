import { X } from "lucide-react";
import { Dialog as RadixDialog, Popover as RadixPopover } from "radix-ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, cx, Dot, type Tone } from "./primitives";

/* ---------- Dialog & Drawer ---------- */

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

function Header({ title, description, divided }: Pick<OverlayProps, "title" | "description"> & { divided?: boolean }) {
  return (
    <header className={cx("flex items-start justify-between gap-4 px-5", divided ? "border-b border-line py-3.5" : "pt-4.5 pb-1")}>
      <div className="min-w-0">
        <RadixDialog.Title className="t-heading text-base">{title}</RadixDialog.Title>
        {description ? (
          <RadixDialog.Description className="mt-0.5 text-xs text-ink-3">{description}</RadixDialog.Description>
        ) : (
          <RadixDialog.Description className="sr-only">{typeof title === "string" ? title : "对话框"}</RadixDialog.Description>
        )}
      </div>
      <RadixDialog.Close asChild>
        <Button variant="ghost" size="sm" icon={<X />} aria-label="关闭" className="-mr-1.5" />
      </RadixDialog.Close>
    </header>
  );
}

export function Dialog({ open, onOpenChange, title, description, children, footer, width = "max-w-lg" }: OverlayProps & { width?: string }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <RadixDialog.Content
          className={cx(
            "fixed top-[12dvh] left-1/2 z-50 flex max-h-[76dvh] max-sm:top-[6dvh] max-sm:max-h-[88dvh] w-[calc(100vw-2rem)] -translate-x-1/2 animate-in flex-col",
            "rounded-panel bg-overlay shadow-overlay",
            width,
          )}
        >
          <Header title={title} description={description} />
          <div className={cx("min-h-0 flex-1 overflow-y-auto px-5 pt-3", footer ? "pb-4" : "pb-5")}>{children}</div>
          {footer && <footer className="flex justify-end gap-2 px-5 pt-1 pb-5">{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A panel that slides in from the right, for inspecting one item of a list. */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  side = "right",
  width,
  bodyClassName = "p-5",
  trigger,
}: OverlayProps & {
  side?: "left" | "right";
  width?: string;
  bodyClassName?: string;
  /** The control that opens the drawer, which gets the focus back when it closes. */
  trigger?: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <RadixDialog.Content
          className={cx(
            "fixed inset-y-0 z-50 flex animate-slide flex-col border-line bg-overlay pb-[env(safe-area-inset-bottom)] shadow-overlay",
            side === "right" ? cx("right-0 border-l", width ?? "w-[min(44rem,100vw)]") : cx("left-0 border-r", width ?? "w-[min(18rem,85vw)]"),
          )}
        >
          <Header title={title} description={description} divided />
          <div className={cx("min-h-0 flex-1 overflow-y-auto", bodyClassName)}>{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * A panel at the right edge that leaves the page usable: what it shows can be
 * changed from the page behind it, as when stepping through the rows of a
 * list. It has no scrim and does not take the focus. On a narrow window it
 * covers the page.
 */
export function SidePanel({ label, onClose, className, children }: { label: string; onClose: () => void; className?: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || modalOpen() || tooltipOpen()) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <section
      aria-label={label}
      className={cx(
        "fixed inset-y-0 right-0 z-30 flex w-full animate-slide flex-col border-l border-line bg-overlay pb-[env(safe-area-inset-bottom)] shadow-overlay",
        className,
      )}
    >
      {children}
    </section>,
    document.body,
  );
}

/** Whether a tooltip is up; Escape closes it first. */
export const tooltipOpen = () => !!document.querySelector('[data-state="delayed-open"], [data-state="instant-open"]');

/** Whether a dialog, a drawer or a menu has the page; keys then belong to it. */
export const modalOpen = () => !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]');

/* ---------- Popover ---------- */

/**
 * A small panel anchored to the control that opens it, for a choice made in
 * place. Pass `open` and `onOpenChange` to close it once the choice is made.
 */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = "start",
  className = "w-80",
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cx(
            "z-50 max-h-(--radix-popover-content-available-height) max-w-[calc(100vw-1.5rem)] animate-in overflow-y-auto",
            "rounded-panel bg-overlay shadow-overlay focus-visible:outline-none",
            className,
          )}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/* ---------- Confirm ---------- */

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirm: string;
  danger?: boolean;
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false);

export const useConfirm = () => useContext(ConfirmContext);

/* ---------- Toast ---------- */

interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

export const useToast = () => useContext(ToastContext);

/** Hosts the toasts and the confirm dialog for the whole app. */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const toast = useCallback((message: string, tone: Tone = "ok") => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === "err" ? 7000 : 3200);
  }, []);

  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const toastValue = useMemo(() => toast, [toast]);
  return (
    <ToastContext.Provider value={toastValue}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        <Dialog
          open={pending !== null}
          onOpenChange={(open) => !open && settle(false)}
          title={pending?.title ?? ""}
          width="max-w-sm"
          footer={
            <>
              <Button onClick={() => settle(false)}>取消</Button>
              <Button variant={pending?.danger ? "danger" : "primary"} onClick={() => settle(true)} autoFocus>
                {pending?.confirm}
              </Button>
            </>
          }
        >
          <div className="text-sm text-ink-2">{pending?.body}</div>
        </Dialog>
        <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="pointer-events-auto flex animate-in items-start gap-2.5 rounded-panel bg-overlay px-3.5 py-3 text-sm shadow-overlay">
              <Dot tone={t.tone} className="mt-2" />
              <span className="min-w-0 flex-1 break-words">{t.message}</span>
            </div>
          ))}
        </div>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
