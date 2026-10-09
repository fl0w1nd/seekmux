import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
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

function Header({ title, description }: Pick<OverlayProps, "title" | "description">) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
      <div className="min-w-0">
        <RadixDialog.Title className="text-base font-medium">{title}</RadixDialog.Title>
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
            "fixed top-[12vh] left-1/2 z-50 flex max-h-[76vh] w-[calc(100vw-2rem)] -translate-x-1/2 animate-in flex-col",
            "rounded-panel border border-line-strong bg-overlay shadow-overlay",
            width,
          )}
        >
          <Header title={title} description={description} />
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A panel that slides in from the right, for inspecting one item of a list. */
export function Drawer({ open, onOpenChange, title, description, children }: OverlayProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <RadixDialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(44rem,100vw)] animate-slide flex-col border-l border-line-strong bg-overlay shadow-overlay">
          <Header title={title} description={description} />
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
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
            <div key={t.id} className="pointer-events-auto flex animate-in items-start gap-2.5 rounded-ctl border border-line-strong bg-overlay px-3 py-2.5 text-sm shadow-overlay">
              <Dot tone={t.tone} className="mt-2" />
              <span className="min-w-0 flex-1 break-words">{t.message}</span>
            </div>
          ))}
        </div>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
