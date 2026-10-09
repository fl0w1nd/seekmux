import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "../ui/overlays";
import { Spinner } from "../ui/primitives";
import { api, type Config, type Meta, type ProviderInfo } from "./api";

interface ConfigContextValue {
  /** The configuration as edited; it differs from the server's until saved. */
  config: Config;
  meta: Meta;
  /** Mutates a copy of the draft. */
  update: (mutate: (draft: Config) => void) => void;
  dirty: boolean;
  saving: boolean;
  save: () => void;
  discard: () => void;
  provider: (id: string) => ProviderInfo;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function useConfig(): ConfigContextValue {
  const value = useContext(ConfigContext);
  if (!value) throw new Error("useConfig needs a ConfigProvider");
  return value;
}

/**
 * Loads the configuration and holds one draft for every settings page, so a
 * change spanning several pages is saved, and takes effect, as a whole.
 */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
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

  const mutation = useMutation({
    mutationFn: api.saveConfig,
    onSuccess: (saved, submitted) => {
      keepDraft.current = JSON.stringify(latest.current) !== JSON.stringify(submitted);
      client.setQueryData(["config"], saved);
      void client.invalidateQueries({ queryKey: ["overview"] });
      toast("配置已保存并生效");
    },
    onError: (error) => toast(`保存失败：${error.message}`, "err"),
  });

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
    save: () => mutation.mutate(draft),
    discard: () => setDraft(structuredClone(server.data)),
    provider: (id) => catalog.find((p) => p.id === id) ?? { id, name: id, website: "", key_required: true, default_base_url: {}, default_rate_limit: {} },
  };
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}
