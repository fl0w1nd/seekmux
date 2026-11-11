import { ChevronLeft, ChevronRight, ExternalLink, Plus, Server } from "lucide-react";
import { useState } from "react";
import { Collapsible as RadixCollapsible } from "radix-ui";
import { Link, Redirect, useLocation, useParams } from "wouter";
import { CardRow, ProviderRoutes } from "../components/CardRow";
import { healthLabel, Reenable, useStatus } from "../components/Health";
import type { Fetcher, FetcherWorker, Provider, ProviderInfo, RoutedTool } from "../lib/api";
import { useConfig } from "../lib/config";
import { providerCategories } from "../lib/pages";
import { toolLabel } from "../lib/format";
import { routingRules } from "../lib/routing";
import { PageHeader } from "../components/PageHeader";
import { BrandIcon } from "../ui/brand";
import { RateLimitInput, SecretInput } from "../ui/inputs";
import { Button, cx, Dot, Empty, Info, Input, Notice, NumberInput, Panel, State, type Tone } from "../ui/primitives";
import { addFetcher, CreateFetcherDialog, FetcherDetail, fetcherState } from "./Fetchers";

type Status = ReturnType<typeof useStatus>;

/** One provider in the list: a built-in one or a self-hosted fetcher. */
interface Entry {
  id: string;
  name: string;
  /** The logo: the provider's own, or a fetcher's type. */
  icon: string;
  tools: RoutedTool[];
  state: { tone: Tone; label: string; short?: string };
  fetcher?: Fetcher;
}

/** How a built-in provider stands, in a few words: what a route of it lacks, or that it is set up. */
function builtinState(info: ProviderInfo, creds: Provider, status: Status): { tone: Tone; label: string; short?: string } {
  const off = status?.routes.filter((r) => r.provider === info.id && r.available && r.disabled) ?? [];
  if (off.some((r) => r.disabled_reason === "auth")) return { tone: "err", label: "密钥被拒" };
  if (off.some((r) => r.disabled_reason === "quota")) return { tone: "err", label: "额度用尽" };
  if (off.length > 0) return { tone: "warn", label: "已熔断" };
  if (creds.api_key || (creds.api_key_hint && !creds.clear_api_key)) return { tone: "ok", label: "已配置" };
  if (!info.key_required) return { tone: "ok", label: "免密钥" };
  return { tone: "neutral", label: "未配置" };
}

/**
 * The providers in three groups: built-in ones that are set up (a key, an
 * address of their own, or in use without needing a key), the self-hosted
 * fetchers, and the built-in ones that are not set up.
 */
function useEntries(): { cloud: Entry[]; self: Entry[]; idle: Entry[] } {
  const { config, meta } = useConfig();
  const status = useStatus();
  const routed = new Set(
    [config.search.routes, config.dev_search.routes, config.fetch.routes].flatMap((routes) => routes.filter((r) => r.enabled).map((r) => r.provider)),
  );
  for (const rule of routingRules(config, meta)) if (rule.enabled) for (const id of rule.providers) routed.add(id);

  const cloud: Entry[] = [];
  const idle: Entry[] = [];
  for (const info of meta.catalog) {
    const creds = config.providers[info.id];
    const state = builtinState(info, creds, status);
    const entry: Entry = { id: info.id, name: info.name, icon: info.id, tools: info.tools, state };
    const keyed = Boolean(creds.api_key || (creds.api_key_hint && !creds.clear_api_key));
    const set = keyed || Boolean(creds.base_url) || (!info.key_required && routed.has(info.id));
    (set ? cloud : idle).push(entry);
  }
  const self: Entry[] = config.fetchers.map((fetcher) => {
    const state = fetcherState(fetcher, status);
    const short = state.label === "无可用 Worker" ? "无可用" : state.label === "未启用 Worker" ? "未启用" : state.label;
    return {
      id: fetcher.id,
      name: fetcher.name || fetcher.id,
      icon: fetcher.type,
      tools: ["fetch"],
      state: { ...state, short },
      fetcher,
    };
  });
  return { cloud, self, idle };
}

/**
 * The providers of one category: their list on the left and the chosen
 * provider's settings on the right, in one frame.
 */
export function ProvidersPage() {
  const { category, id } = useParams<{ category?: string; id?: string }>();
  const { config, meta, update } = useConfig();
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  // The fetcher just created here, whose setup guide opens by itself.
  const [created, setCreated] = useState<string>();
  // A token generated here is shown in its worker's command until the page
  // is left; the saved one comes back only as a hint.
  const [fresh, setFresh] = useState<Record<string, string>>({});
  const remember = (worker: FetcherWorker) => setFresh((f) => ({ ...f, [worker.id]: worker.token }));

  const groups = useEntries();
  const current = providerCategories.find((c) => c.value === category);
  if (!current) {
    // An address from before the categories names the provider straight after /providers.
    if (category && groups.self.some((e) => e.id === category)) return <Redirect to={`/providers/self/${category}`} replace />;
    if (category && [...groups.cloud, ...groups.idle].some((e) => e.id === category)) return <Redirect to={`/providers/cloud/${category}`} replace />;
    return <Redirect to="/providers/cloud" replace />;
  }

  const base = `/providers/${current.value}`;
  const self = current.value === "self";
  const entries = self ? groups.self : [...groups.cloud, ...groups.idle];
  // Without one in the address, the wide layout shows the first.
  const selected = entries.find((e) => e.id === (id ?? entries[0]?.id));
  if (id && !selected) return <Redirect to={base} replace />;
  const create = () => setCreating(true);

  return (
    <>
      <PageHeader
        section="提供商"
        title={current.label}
        actions={
          self &&
          entries.length > 0 && (
            <Button variant="primary" icon={<Plus />} onClick={create}>
              新建抓取器
            </Button>
          )
        }
      />
      {self && entries.length === 0 ? (
        <Panel>
          <Empty size="page" icon={<Server />} title="尚无自托管抓取器">
            <Button variant="primary" icon={<Plus />} onClick={create}>
              新建抓取器
            </Button>
          </Empty>
        </Panel>
      ) : (
        <>
          {id && (
            <Link href={base} className="mb-2.5 inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink lg:hidden">
              <ChevronLeft className="size-4" />
              全部{current.label}
            </Link>
          )}
          <div className="overflow-hidden rounded-panel border border-line bg-surface lg:grid lg:min-h-[calc(100dvh-9rem)] lg:grid-cols-[14rem_minmax(0,1fr)]">
            <nav aria-label={current.label} className={cx("border-line p-1.5 lg:border-r", id && "max-lg:hidden")}>
              {self ? (
                groups.self.map((e) => <EntryRow key={e.id} base={base} entry={e} active={e.id === selected?.id} />)
              ) : (
                <CloudList groups={groups} base={base} active={selected?.id} />
              )}
            </nav>
            <div className={cx("min-w-0", !id && "max-lg:hidden")}>
              {selected?.fetcher ? (
                <FetcherDetail
                  key={selected.id}
                  fetcher={selected.fetcher}
                  fresh={fresh}
                  remember={remember}
                  created={created === selected.id}
                  onGuideClosed={() => setCreated(undefined)}
                  onRemoved={() => navigate(base, { replace: true })}
                />
              ) : (
                selected && <BuiltinDetail key={selected.id} id={selected.id} />
              )}
            </div>
          </div>
        </>
      )}
      <CreateFetcherDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={(type, name) => {
          const { id: made, worker } = addFetcher(config, meta, update, type, name);
          remember(worker);
          setCreated(made);
          setCreating(false);
          navigate(`/providers/self/${made}`);
        }}
      />
    </>
  );
}

/** The cloud services that are set up, then a fold of those that are not. */
function CloudList({ groups, base, active }: { groups: ReturnType<typeof useEntries>; base: string; active?: string }) {
  const [open, setOpen] = useState(false);
  const idleOpen = open || groups.idle.some((e) => e.id === active);
  return (
    <>
      {groups.cloud.map((e) => (
        <EntryRow key={e.id} base={base} entry={e} active={e.id === active} />
      ))}
      {groups.idle.length > 0 && (
        <RadixCollapsible.Root open={idleOpen} onOpenChange={setOpen} className={cx("group/idle", groups.cloud.length > 0 && "mt-1.5 border-t border-line pt-1.5")}>
          <RadixCollapsible.Trigger className="flex h-8 w-full items-center gap-1.5 rounded-ctl px-2 text-left transition-colors hover:bg-fill">
            <ChevronRight className="size-3.5 text-ink-3 transition-transform group-data-[state=open]/idle:rotate-90" />
            <span className="tag">未配置</span>
            <span className="num ml-auto text-2xs text-ink-3">{groups.idle.length}</span>
          </RadixCollapsible.Trigger>
          <RadixCollapsible.Content className="flex flex-col gap-px">
            {groups.idle.map((e) => (
              <EntryRow key={e.id} base={base} entry={e} active={e.id === active} quiet />
            ))}
          </RadixCollapsible.Content>
        </RadixCollapsible.Root>
      )}
    </>
  );
}

/** A provider's row in the list: one compact line; `quiet` leaves out the state of a provider that is not set up. */
function EntryRow({ base, entry, active, quiet }: { base: string; entry: Entry; active: boolean; quiet?: boolean }) {
  return (
    <Link
      href={`${base}/${entry.id}`}
      aria-current={active ? "page" : undefined}
      className={cx(
        "mt-px flex h-9 items-center gap-2.5 rounded-ctl px-2 transition-colors max-lg:h-11",
        active ? "lg:bg-fill lg:font-medium" : "hover:bg-fill",
      )}
    >
      <BrandIcon id={entry.icon} className="size-4 shrink-0" />
      <span className={cx("min-w-0 flex-1 truncate text-sm", quiet && !active ? "text-ink-2" : "text-ink")}>{entry.name}</span>
      {!quiet && (
        <span className="flex shrink-0 items-center gap-1.5 text-2xs font-normal text-ink-3">
          <Dot tone={entry.state.tone} halo={false} />
          <span>{entry.state.short ?? entry.state.label}</span>
        </span>
      )}
    </Link>
  );
}

/** The settings of a built-in provider: its key, limits, address and active routes. */
function BuiltinDetail({ id }: { id: string }) {
  const { config, update, meta } = useConfig();
  const status = useStatus();
  const info = meta.catalog.find((p) => p.id === id)!;
  const creds = config.providers[info.id];
  const tools = info.tools;
  const off = status?.routes.filter((r) => r.provider === info.id && r.available && r.disabled) ?? [];
  const defaultUrl = Object.values(info.default_base_url)[0];
  const state = builtinState(info, creds, status);
  const set = (change: (p: Provider) => void) => update((d) => void change(d.providers[info.id]));

  return (
    <section className="flex flex-col">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <BrandIcon id={info.id} className="size-5" />
          <span className="t-heading truncate">{info.name}</span>
          <State tone={state.tone}>{state.label}</State>
        </span>
        <a
          href={info.website}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink"
        >
          控制台 <ExternalLink className="size-3" />
        </a>
      </header>

      {off.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-line px-4 py-3">
          {off.map((route) => {
            const account = route.disabled_reason === "auth" || route.disabled_reason === "quota";
            return (
              <Notice key={route.key} tone={account ? "err" : "warn"}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-medium text-ink">
                      {toolLabel[route.tool]}：{healthLabel(route)}
                    </span>
                    <p className="mt-0.5">
                      {route.disabled_reason === "auth"
                        ? "更换密钥后自动恢复。"
                        : route.disabled_reason === "quota"
                          ? route.disabled_ms > 0
                            ? "到重置时间自动恢复。"
                            : "充值后重新启用。"
                          : "冷却后自动重试。"}
                    </p>
                    {route.disabled_detail && <p className="num mt-1 break-all text-ink-3">{route.disabled_detail}</p>}
                  </div>
                  <Reenable id={route.key} />
                </div>
              </Notice>
            );
          })}
        </div>
      )}

      <div>
        <CardRow label="API Key" aside={!info.key_required && "可选"}>
          <div className="max-w-md">
            <SecretInput
              value={creds}
              placeholder={info.key_required ? "粘贴 API Key" : "填写后额度更高"}
              onChange={(next) => update((d) => void (d.providers[info.id] = next))}
            />
          </div>
        </CardRow>

        <CardRow
          label="配额限流"
          aside={
            tools.length > 1 && (
              <div className="flex items-center gap-1 text-2xs text-ink-3">
                {tools.length} 工具共用
                <Info>{`${tools.map((tool) => toolLabel[tool]).join("、")}的调用合并计数`}</Info>
              </div>
            )
          }
        >
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <RateLimitInput value={creds.rate_limit} fallback={info.default_rate_limit} onChange={(rate_limit) => set((p) => (p.rate_limit = rate_limit))} />
            <div className="flex items-center gap-1.5 text-xs text-ink-3">
              <span>并发</span>
              <NumberInput
                className="w-20"
                min={0}
                zero="不限"
                value={creds.concurrency}
                onChange={(concurrency) => set((p) => (p.concurrency = Math.max(0, Math.round(concurrency))))}
                aria-label={`${info.name} 并发上限`}
              />
            </div>
          </div>
        </CardRow>

        <CardRow label="接口地址" aside={creds.base_url && <div className="text-2xs text-ink-3">已自定义</div>}>
          <div className="flex max-w-md items-center gap-2">
            <Input
              mono
              value={creds.base_url ?? ""}
              placeholder={defaultUrl}
              aria-label={`${info.name} 接口地址`}
              onChange={(e) => set((p) => (p.base_url = e.target.value.trim() || undefined))}
            />
            {creds.base_url && (
              <Button size="sm" variant="ghost" onClick={() => set((p) => (p.base_url = undefined))}>
                恢复默认
              </Button>
            )}
          </div>
        </CardRow>
      </div>

      <ProviderRoutes id={info.id} tools={tools} />
    </section>
  );
}
