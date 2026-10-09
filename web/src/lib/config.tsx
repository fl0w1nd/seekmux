import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Spinner } from "../ui/primitives";
import { api, type Config, type Meta, type ProviderInfo } from "./api";

interface ConfigContextValue {
  /** The configuration as edited; it differs from the server's until saved. */
  config: Config;
  meta: Meta;
  /** Mutates a copy of the draft. */
  update: (mutate: (draft: Config) => void) => void;
  /** Edits are saved by themselves; dirty until the server has them. */
  dirty: boolean;
  saving: boolean;
  /** Why the last save was refused; the draft stays as edited meanwhile. */
  error: string;
  retry: () => void;
  discard: () => void;
  provider: (id: string) => ProviderInfo;
}

/** Whether the caret is in a field whose value is still being entered. */
function typing(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range"].includes(el.type);
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function useConfig(): ConfigContextValue {
  const value = useContext(ConfigContext);
  if (!value) throw new Error("useConfig needs a ConfigProvider");
  return value;
}

/**
 * Loads the configuration and saves every edit by itself. A text field is
 * saved when it is left or Enter is pressed, never while it is being typed in,
 * so a half-entered key or number does not reach live traffic.
 */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const server = useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: Infinity });
  const [draft, setDraft] = useState<Config | null>(null);

  // Edits made while a save was under way stay in the draft.
  const latest = useRef(draft);
  latest.current = draft;
  const keepDraft = useRef(false);

  useEffect(() => {
    if (!server.data) return;
    if (keepDraft.current) keepDraft.current = false;
    else setDraft(structuredClone(server.data));
  }, [server.data]);

  const dirty = useMemo(
    () => draft !== null && server.data !== undefined && JSON.stringify(draft) !== JSON.stringify(server.data),
    [draft, server.data],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const [failure, setFailure] = useState<{ draft: string; message: string } | null>(null);
  const mutation = useMutation({
    mutationFn: api.saveConfig,
    onSuccess: (saved, submitted) => {
      keepDraft.current = JSON.stringify(latest.current) !== JSON.stringify(submitted);
      setFailure(null);
      client.setQueryData(["config"], saved);
      void client.invalidateQueries({ queryKey: ["overview"] });
      void client.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error, submitted) => setFailure({ draft: JSON.stringify(submitted), message: error.message }),
  });

  // A draft the server refused is not sent again until it changes.
  const refused = failure !== null && failure.draft === JSON.stringify(draft);
  const { mutate, isPending } = mutation;
  useEffect(() => {
    if (!dirty || !draft || isPending || refused) return;
    let sent = false;
    const send = (force = false) => {
      if (sent || (!force && typing())) return;
      sent = true;
      mutate(draft);
    };
    const timer = setTimeout(send, 300);
    const onFocusOut = () => setTimeout(send, 0);
    const onKeyDown = (e: KeyboardEvent) => e.key === "Enter" && e.target instanceof HTMLInputElement && send(true);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dirty, draft, isPending, refused, mutate]);

  const update = useCallback((mutate: (draft: Config) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
  }, []);

  if (meta.error || server.error) {
    return <div className="p-8 text-sm text-err">加载配置失败：{(meta.error ?? server.error)?.message}</div>;
  }
  if (!draft || !meta.data || !server.data) {
    return (
      <div className="grid h-screen place-items-center">
        <Spinner />
      </div>
    );
  }

  const catalog = meta.data.catalog;
  const value: ConfigContextValue = {
    config: draft,
    meta: meta.data,
    update,
    dirty,
    saving: mutation.isPending,
    error: refused ? failure.message : "",
    retry: () => setFailure(null),
    discard: () => {
      setFailure(null);
      setDraft(structuredClone(server.data));
    },
    provider: (id) => catalog.find((p) => p.id === id) ?? { id, name: id, website: "", key_required: true, default_base_url: {}, default_rate_limit: {} },
  };
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}
