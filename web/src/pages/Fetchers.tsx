import { ArrowDown, ArrowUp, BookOpen, Check, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { CardRow, ProviderRoutes } from "../components/CardRow";
import { Tripped, useStatus } from "../components/Health";
import { type api, type Config, type Fetcher, type FetcherWorker, type Meta, type RouteStatus, type WorkerProfile, type WorkerStatus } from "../lib/api";
import { useConfig } from "../lib/config";
import { routingRules } from "../lib/routing";
import { BrandIcon } from "../ui/brand";
import { RateLimitInput } from "../ui/inputs";
import { Dialog, Drawer, useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, Choice, ChoiceList, CodeBlock, cx, Field, Info, Input, NumberInput, Select, Switch, TabList, TabPanel, Tabs, type Tone } from "../ui/primitives";

/** A token a worker can present: 32 random bytes, URL-safe. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "smw_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The token generated here for a worker, while it is still the one the
 * server keeps: a rotation the server refused, then discarded, leaves the
 * old token in place, whose hint no longer ends like the remembered one.
 */
function current(worker: FetcherWorker, remembered?: string): string | undefined {
  if (!remembered || !worker.token_hint) return undefined;
  return worker.token_hint.endsWith(remembered.slice(-4)) ? remembered : undefined;
}

/** A worker id: short, random, and never reused for another device. */
function newWorkerID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "w" + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

function newWorker(n: number): FetcherWorker {
  return { id: newWorkerID(), name: `Worker ${n}`, enabled: true, token: newToken() };
}

/** The first free id for a fetcher of a type: the type itself, then type-2, type-3… */
function newFetcherID(config: Config, meta: Meta, type: string): string {
  const taken = new Set([...meta.catalog.map((p) => p.id), ...config.fetchers.map((f) => f.id)]);
  if (!taken.has(type)) return type;
  for (let n = 2; ; n++) if (!taken.has(`${type}-${n}`)) return `${type}-${n}`;
}

/**
 * What keeps a worker from reading with its profile, by OpenCLI's own rule
 * (as the gateway applies it): a chosen profile must be open; without one,
 * the default is used, else the only open profile.
 */
function profileProblem(profiles: WorkerProfile[], chosen: string): { tone: Tone; label: string; detail: string } | undefined {
  const connected = profiles.filter((p) => p.connected);
  if (chosen) {
    if (!profiles.some((p) => p.id === chosen)) return { tone: "err", label: "Profile 不存在", detail: "Worker 上的 OpenCLI 不认识所选 Profile，抓取会交给下一个 Worker。" };
    if (!connected.some((p) => p.id === chosen)) return { tone: "warn", label: "Profile 未打开", detail: "所选 Profile 的 Chrome 没有打开，抓取会交给下一个 Worker。" };
    return undefined;
  }
  if (connected.length > 1 && !connected.some((p) => p.default))
    return { tone: "err", label: "需选择 Profile", detail: `连接了 ${connected.length} 个 Profile 且没有默认的，请为这个 Worker 选择一个。` };
  return undefined;
}

/** Whether a worker takes fetches now, in a few words. */
function workerState(worker: FetcherWorker, status?: WorkerStatus): { tone: Tone; label: string; usable: boolean } {
  if (!worker.enabled) return { tone: "neutral", label: "已停用", usable: false };
  if (!status?.connected) return { tone: "warn", label: "离线", usable: false };
  if (!status.state?.ready) return { tone: "warn", label: "浏览器未就绪", usable: false };
  const problem = profileProblem(status.state.profiles, worker.profile ?? "");
  if (problem) return { ...problem, usable: false };
  return { tone: "ok", label: "在线", usable: true };
}

type Status = Awaited<ReturnType<typeof api.status>>;

/** How a fetcher stands as a whole: tripped, or how many of its enabled workers take fetches now. */
export function fetcherState(fetcher: Fetcher, status?: Status): { tone: Tone; label: string; health?: RouteStatus } {
  const health = status?.routes.find((r) => r.key === `${fetcher.id}:fetch`);
  if (health?.disabled) return { tone: "warn", label: "已熔断", health };
  const enabled = fetcher.workers.filter((w) => w.enabled).length;
  if (enabled === 0) return { tone: "neutral", label: "未启用 Worker" };
  const usable = fetcher.workers.filter((w) => workerState(w, status?.workers[w.id]).usable).length;
  if (usable > 0) return { tone: "ok", label: `${usable}/${enabled} 可用` };
  return { tone: "warn", label: "无可用 Worker" };
}

/** Adds a fetcher of the chosen type with one worker, and returns its id. */
export function addFetcher(config: Config, meta: Meta, update: (change: (draft: Config) => void) => void, type: Meta["fetcher_types"][number], name: string): {
  id: string;
  worker: FetcherWorker;
} {
  const id = newFetcherID(config, meta, type.id);
  const worker = newWorker(1);
  update((d) => {
    d.fetchers.push({ id, type: type.id, name, rate_limit: type.default_rate_limit, concurrency: 0, workers: [worker] });
  });
  return { id, worker };
}

export function CreateFetcherDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (type: Meta["fetcher_types"][number], name: string) => void }) {
  const { meta } = useConfig();
  const [type, setType] = useState(meta.fetcher_types[0]?.id ?? "");
  const [name, setName] = useState("");
  const chosen = meta.fetcher_types.find((t) => t.id === type);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="新建抓取器"
      description="用自己已登录的浏览器读取需要登录的页面"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!chosen}
            onClick={() => {
              if (!chosen) return;
              onCreate(chosen, name.trim() || chosen.name);
              setName("");
            }}
          >
            创建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ChoiceList label="类型">
          {meta.fetcher_types.map((t) => (
            <Choice
              key={t.id}
              checked={type === t.id}
              onSelect={() => setType(t.id)}
              title={
                <span className="flex items-center gap-2">
                  <BrandIcon id={t.id} className="size-4" />
                  {t.name}
                </span>
              }
              detail={t.id === "opencli" ? "通过 OpenCLI 扩展驱动 Chrome" : undefined}
            />
          ))}
        </ChoiceList>
        <Field label="名称">
          <Input value={name} placeholder={chosen?.name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

type FetcherTab = "settings" | "workers" | "adapters";

/** A self-hosted fetcher on the providers page: its settings, workers and adapters, one tab each. */
export function FetcherDetail({
  fetcher,
  fresh,
  remember,
  onRemoved,
  created,
  onGuideClosed,
}: {
  fetcher: Fetcher;
  fresh: Record<string, string>;
  remember: (worker: FetcherWorker) => void;
  onRemoved: () => void;
  /** Just created here: the setup guide opens by itself. */
  created?: boolean;
  onGuideClosed?: () => void;
}) {
  const { config, update, meta } = useConfig();
  const status = useStatus();
  const confirm = useConfirm();
  const toast = useToast();
  const type = meta.fetcher_types.find((t) => t.id === fetcher.type);
  const adapters = type?.adapters ?? [];
  // A fetcher just created opens on its workers, whose command is what comes next.
  const [tab, setTab] = useState<FetcherTab>(() => (fetcher.workers.some((w) => fresh[w.id]) ? "workers" : "settings"));
  const set = (change: (f: Fetcher) => void) =>
    update((d) => {
      const f = d.fetchers.find((x) => x.id === fetcher.id);
      if (f) change(f);
    });
  const state = fetcherState(fetcher, status);
  const route = config.fetch.routes.find((r) => r.provider === fetcher.id);
  const rules = routingRules(config, meta).filter((r) => r.enabled && r.providers.includes(fetcher.id));
  const used = Boolean(route?.enabled) || rules.length > 0;
  const guided = fetcher.type === "opencli";
  // The worker the setup guide is open for.
  const [guide, setGuide] = useState<string | undefined>(() => (guided && created ? fetcher.workers[0]?.id : undefined));
  const guideIndex = fetcher.workers.findIndex((w) => w.id === guide);
  const openGuide = () => {
    const waiting = fetcher.workers.find((w) => w.enabled && !workerState(w, status?.workers[w.id]).usable);
    setGuide((waiting ?? fetcher.workers[0])?.id);
  };
  const regenerate = (i: number) => {
    const worker = fetcher.workers[i];
    const token = newToken();
    remember({ ...worker, token });
    set((f) => (f.workers[i].token = token));
  };

  const remove = async () => {
    const only = config.routing.rules.filter((r) => r.providers.length === 1 && r.providers[0] === fetcher.id);
    if (only.length > 0) {
      toast(`规则「${only.map((r) => r.name).join("」「")}」只用这个抓取器，请先修改规则`, "err");
      return;
    }
    const ok = await confirm({
      title: `删除抓取器 ${fetcher.name}？`,
      body: "Worker 断开、令牌失效，路由中对它的引用一并移除。",
      confirm: "删除",
      danger: true,
    });
    if (!ok) return;
    update((d) => {
      d.fetchers = d.fetchers.filter((f) => f.id !== fetcher.id);
      for (const rule of d.routing.rules) rule.providers = rule.providers.filter((id) => id !== fetcher.id);
      for (const [id, rule] of Object.entries(d.routing.builtin ?? {})) {
        const providers = (rule.providers ?? []).filter((p) => p !== fetcher.id);
        if (providers.length === 0) delete d.routing.builtin![id];
        else d.routing.builtin![id] = { ...rule, providers };
      }
    });
    onRemoved();
  };

  const tabs: { value: FetcherTab; label: ReactNode }[] = [
    { value: "settings", label: "设置" },
    {
      value: "workers",
      label: (
        <>
          Worker <span className="num text-2xs text-ink-3">{fetcher.workers.length}</span>
        </>
      ),
    },
  ];
  if (adapters.length > 0)
    tabs.push({
      value: "adapters",
      label: (
        <>
          适配器 <span className="num text-2xs text-ink-3">{adapters.length}</span>
        </>
      ),
    });

  const customName = Boolean(type && fetcher.name.trim().toLowerCase() !== type.name.toLowerCase());

  return (
    <section className="flex flex-col">
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <BrandIcon id={fetcher.type} className="size-4" />
          <span className="truncate">{fetcher.name}</span>
          {state.health ? (
            <Tripped id={state.health.key} health={state.health} />
          ) : (
            <Badge tone={state.tone} dot={state.tone !== "neutral"}>
              {state.label}
            </Badge>
          )}
        </span>
        <span className="flex items-center gap-2">
          {customName && <Badge>{type?.name ?? fetcher.type}</Badge>}
          {fetcher.id !== fetcher.type && <span className="num text-2xs text-ink-3">{fetcher.id}</span>}
          {type?.website && (
            <a href={type.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink">
              项目 <ExternalLink className="size-3" />
            </a>
          )}
          {guided && fetcher.workers.length > 0 && (
            <Button size="sm" variant="ghost" icon={<BookOpen />} onClick={openGuide}>
              安装指南
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Trash2 />} aria-label={`删除 ${fetcher.name}`} onClick={remove} />
        </span>
      </header>

      <Tabs value={tab} onChange={setTab}>
        <TabList
          tabs={tabs}
          actions={
            tab === "workers" && (
              <div className="flex items-center gap-3">
                {fetcher.workers.length > 1 && <span className="hidden text-xs text-ink-3 sm:inline">按顺序故障转移</span>}
                <Button
                  size="sm"
                  icon={<Plus />}
                  onClick={() => {
                    const worker = newWorker(fetcher.workers.length + 1);
                    remember(worker);
                    set((f) => f.workers.push(worker));
                  }}
                >
                  添加 Worker
                </Button>
              </div>
            )
          }
        />

        <TabPanel value="settings">
          <div>
            <CardRow label="名称">
              <Input className="w-64 max-w-full" value={fetcher.name} maxLength={64} aria-label="抓取器名称" onChange={(e) => set((f) => (f.name = e.target.value))} />
            </CardRow>
            <CardRow label="配额限流" aside="所有 Worker 共用">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <RateLimitInput value={fetcher.rate_limit} fallback={type?.default_rate_limit} onChange={(rate_limit) => set((f) => (f.rate_limit = rate_limit))} />
                <div className="flex items-center gap-1.5 text-xs text-ink-3">
                  <span>并发</span>
                  <NumberInput
                    className="w-20"
                    min={0}
                    zero="不限"
                    value={fetcher.concurrency}
                    onChange={(concurrency) => set((f) => (f.concurrency = Math.max(0, Math.round(concurrency))))}
                    aria-label={`${fetcher.name} 并发上限`}
                  />
                </div>
              </div>
            </CardRow>
          </div>
          <ProviderRoutes id={fetcher.id} tools={["fetch"]} />
        </TabPanel>

        <TabPanel value="workers">
          <ol>
            {fetcher.workers.map((worker, i) => (
              <WorkerItem
                key={worker.id}
                worker={worker}
                index={i}
                count={fetcher.workers.length}
                status={status?.workers[worker.id]}
                token={worker.token || current(worker, fresh[worker.id])}
                set={(change) => set((f) => change(f.workers[i]))}
                move={(by) =>
                  set((f) => {
                    [f.workers[i], f.workers[i + by]] = [f.workers[i + by], f.workers[i]];
                  })
                }
                regenerate={() => regenerate(i)}
                remove={() => set((f) => f.workers.splice(i, 1))}
                guide={guided ? () => setGuide(worker.id) : undefined}
              />
            ))}
          </ol>
        </TabPanel>

        {adapters.length > 0 && (
          <TabPanel value="adapters">
            <Adapters fetcher={fetcher.id} ids={adapters} />
          </TabPanel>
        )}
      </Tabs>

      {guideIndex >= 0 && (
        <SetupGuide
          worker={fetcher.workers[guideIndex]}
          status={status?.workers[fetcher.workers[guideIndex].id]}
          token={fetcher.workers[guideIndex].token || current(fetcher.workers[guideIndex], fresh[fetcher.workers[guideIndex].id])}
          used={used}
          setProfile={(profile) => set((f) => (f.workers[guideIndex].profile = profile))}
          regenerate={() => regenerate(guideIndex)}
          onClose={() => {
            setGuide(undefined);
            onGuideClosed?.();
          }}
        />
      )}
    </section>
  );
}

function WorkerItem({
  worker,
  index,
  count,
  status,
  token,
  set,
  move,
  regenerate,
  remove,
  guide,
}: {
  worker: FetcherWorker;
  index: number;
  count: number;
  status?: WorkerStatus;
  /** The token in full, while it is known: set here and not yet left. */
  token?: string;
  set: (change: (w: FetcherWorker) => void) => void;
  move: (by: -1 | 1) => void;
  regenerate: () => void;
  remove: () => void;
  /** Opens the setup guide for this worker. */
  guide?: () => void;
}) {
  const { config } = useConfig();
  const confirm = useConfirm();
  const state = workerState(worker, status);
  const connected = status?.connected ? status : undefined;
  const profiles = connected?.state?.profiles ?? [];
  const chosen = worker.profile ?? "";
  const problem = connected?.state?.ready ? profileProblem(profiles, chosen) : undefined;
  const command = workerCommand(config, token);

  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <span className={state.usable ? "num w-5 text-sm text-signal-text" : "num w-5 text-sm text-ink-3"}>{String(index + 1).padStart(2, "0")}</span>
        {count > 1 && (
          <span className="flex flex-col">
            <Button size="sm" variant="ghost" className="h-4" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(-1)} />
            <Button size="sm" variant="ghost" className="h-4" icon={<ArrowDown />} aria-label="下移" disabled={index === count - 1} onClick={() => move(1)} />
          </span>
        )}
        <Input className="w-44" value={worker.name} maxLength={64} aria-label="Worker 名称" onChange={(e) => set((w) => (w.name = e.target.value))} />
        <Badge tone={state.tone} dot>
          {state.label}
        </Badge>
        {connected && (
          <span className="flex flex-wrap items-center gap-x-3 text-xs text-ink-3">
            <span className="num text-ink-2">{connected.addr}</span>
            <span>seekmux {connected.version}</span>
            {connected.state?.opencli && <span>OpenCLI {connected.state.opencli}</span>}
            <span>
              任务 <span className="num text-ink-2">{connected.active}</span>/{connected.slots}
            </span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Switch checked={worker.enabled} onCheckedChange={(enabled) => set((w) => (w.enabled = enabled))} aria-label={`启用 ${worker.name}`} />
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 />}
            aria-label={`删除 ${worker.name}`}
            onClick={async () => {
              if (await confirm({ title: `删除 Worker ${worker.name}？`, body: "它会立即断开，令牌随之失效。", confirm: "删除", danger: true })) remove();
            }}
          />
        </span>
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-line/60 bg-bg/30 px-4 py-3 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
        <span className="self-center text-sm text-ink">令牌</span>
        <div className="flex max-w-md min-w-0 items-center gap-2">
          <span className="num flex h-8 min-w-0 flex-1 items-center truncate rounded-ctl border border-line bg-sunken px-2.5 text-sm text-ink-2">
            {token ?? worker.token_hint ?? "未生成"}
          </span>
          <Button
            icon={<RefreshCw />}
            title="重新生成令牌"
            aria-label="重新生成令牌"
            onClick={async () => {
              const ok =
                !connected ||
                (await confirm({ title: `重新生成 ${worker.name} 的令牌？`, body: "已连接的 Worker 会断开，需用新令牌重新运行。", confirm: "重新生成", danger: true }));
              if (ok) regenerate();
            }}
          />
        </div>

        {!connected && (
          <>
            <span className="flex items-center gap-1 self-start pt-1.5 text-sm text-ink">
              运行
              <Info>网关前有反向代理时，需为 /worker 转发 WebSocket 升级</Info>
            </span>
            <div className="flex max-w-xl min-w-0 flex-col gap-1.5">
              <CodeBlock copy wrap>
                {command}
              </CodeBlock>
              <span className="flex flex-wrap items-center gap-x-3 text-2xs text-ink-3">
                {!token && <span>令牌已隐藏，忘记时重新生成</span>}
                {guide && (
                  <button type="button" onClick={guide} className="inline-flex items-center gap-1 text-ink-2 underline underline-offset-2 hover:text-ink">
                    首次使用看安装指南
                  </button>
                )}
              </span>
            </div>
          </>
        )}

        <span className="self-center text-sm text-ink">Profile</span>
        <div className="flex max-w-xs min-w-0 flex-col gap-1.5">
          <Select value={chosen} onChange={(e) => set((w) => (w.profile = e.target.value || undefined))} aria-label={`${worker.name} 的 Chrome Profile`}>
            <option value="">OpenCLI 默认</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.alias ? `${p.alias}（${p.id}）` : p.id}
                {p.connected ? "" : " · 未打开"}
                {p.default ? " · 默认" : ""}
              </option>
            ))}
            {chosen && !profiles.some((p) => p.id === chosen) && (
              <option value={chosen}>
                {chosen}
                {connected ? " · Worker 上不存在" : ""}
              </option>
            )}
          </Select>
          {problem ? (
            <span className={problem.tone === "err" ? "text-xs text-err" : "text-xs text-warn"}>{problem.detail}</span>
          ) : connected && !connected.state?.ready ? (
            <span className="text-xs text-warn">浏览器未就绪：{connected.state?.problem ?? "未知原因"}</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** What a worker runs, with its token while it is known. */
function workerCommand(config: Config, token?: string): string {
  const server = config.network.public_url || window.location.origin;
  return `npx seekmux --server ${server} --token ${token ?? "<Worker 令牌>"}`;
}

const extensionStore = "https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk";
const extensionReleases = "https://github.com/jackwener/opencli/releases";

type StepState = { tone: Tone; label: string; done?: boolean };
const unchecked: StepState = { tone: "neutral", label: "待检测" };
const doneStep = (label = "完成"): StepState => ({ tone: "ok", label, done: true });

/**
 * Setting up one OpenCLI worker, step by step. Each step is checked against
 * what the worker reports, so the list says where the setup stands.
 */
function SetupGuide({
  worker,
  status,
  token,
  used,
  setProfile,
  regenerate,
  onClose,
}: {
  worker: FetcherWorker;
  status?: WorkerStatus;
  token?: string;
  used: boolean;
  setProfile: (profile: string | undefined) => void;
  regenerate: () => void;
  onClose: () => void;
}) {
  const { config } = useConfig();
  const connected = status?.connected ? status : undefined;
  const ready = Boolean(connected?.state?.ready);
  const profiles = connected?.state?.profiles ?? [];
  const chosen = worker.profile ?? "";
  const problem = ready ? profileProblem(profiles, chosen) : undefined;
  const usable = workerState(worker, status).usable;

  const extension: StepState = ready ? doneStep() : connected ? { tone: "err", label: "未连接" } : unchecked;
  const node: StepState = connected ? doneStep() : unchecked;
  const run: StepState = connected ? doneStep("已连接") : !worker.enabled ? { tone: "warn", label: "Worker 已停用" } : { tone: "neutral", label: "等待连接" };
  const profile: StepState = usable ? doneStep() : problem ? { tone: problem.tone, label: problem.label } : unchecked;
  const use: StepState = used ? doneStep("已使用") : { tone: "neutral", label: "未使用" };

  return (
    <Drawer open onOpenChange={(open) => !open && onClose()} title={`安装指南 · ${worker.name}`} description="以下步骤在运行 Chrome 的电脑上完成" width="w-[min(36rem,100vw)]">
      <ol className="flex flex-col">
        <Step n={1} title="安装 OpenCLI 浏览器扩展" state={extension}>
          <p>装进要使用其登录状态的 Chrome Profile，之后保持 Chrome 打开。支持 Chrome 与 Chromium。</p>
          <div>
            <a href={extensionStore} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-ctl border border-line-strong px-2.5 py-1 text-sm text-ink transition-colors hover:bg-raised">
              Chrome 应用商店 <ExternalLink className="size-3.5" />
            </a>
          </div>
          <details className="group">
            <summary className="cursor-pointer text-ink-2 select-none hover:text-ink">无法访问应用商店</summary>
            <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5">
              <li>
                从{" "}
                <a href={extensionReleases} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
                  OpenCLI Releases
                </a>{" "}
                下载 <span className="num text-ink-2">opencli-extension-v&lt;版本&gt;.zip</span> 并解压
              </li>
              <li>
                在地址栏打开 <span className="num text-ink-2">chrome://extensions</span>，开启右上角「开发者模式」
              </li>
              <li>点「加载已解压的扩展程序」，选择解压出的文件夹</li>
            </ol>
          </details>
          {connected && !ready && <p className="text-err">{connected.state?.problem ?? "Chrome 未连接到 OpenCLI"}。确认 Chrome 已打开、扩展已启用。</p>}
        </Step>

        <Step n={2} title="安装 Node.js" state={node}>
          <p>
            需要 22.4 或更高版本，用 <span className="num text-ink-2">node -v</span> 查看。OpenCLI 随 Worker 一起安装，无需单独安装。
          </p>
          <div>
            <a href="https://nodejs.org/zh-cn/download" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink underline underline-offset-2">
              下载 Node.js <ExternalLink className="size-3" />
            </a>
          </div>
        </Step>

        <Step n={3} title="运行 Worker" state={run}>
          {connected ? (
            <p>
              已从 <span className="num text-ink-2">{connected.addr}</span> 连接，seekmux {connected.version}
            </p>
          ) : (
            <>
              <p>在终端中运行，保持终端打开；断线后会自动重连。</p>
              <CodeBlock copy wrap>
                {workerCommand(config, token)}
              </CodeBlock>
              {!token && (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  令牌已隐藏，没有保存时需重新生成。
                  <Button size="sm" icon={<RefreshCw />} onClick={regenerate}>
                    重新生成令牌
                  </Button>
                </p>
              )}
              <p className="flex items-center gap-1">
                连不上网关
                <Info label="连不上网关说明">
                  网关前有反向代理时，需为 /worker 转发 WebSocket 升级（Upgrade、Connection 请求头）。Worker 的终端输出会给出具体原因。
                </Info>
              </p>
            </>
          )}
        </Step>

        <Step n={4} title="选择 Chrome Profile" state={profile}>
          {!ready ? (
            <p>Chrome 连接后显示可用的 Profile。</p>
          ) : (
            <>
              <p>读取页面时使用所选 Profile 的登录状态。只打开了一个 Profile 时可保持默认。</p>
              <Select value={chosen} onChange={(e) => setProfile(e.target.value || undefined)} aria-label={`${worker.name} 的 Chrome Profile`}>
                <option value="">OpenCLI 默认</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.alias ? `${p.alias}（${p.id}）` : p.id}
                    {p.connected ? "" : " · 未打开"}
                    {p.default ? " · 默认" : ""}
                  </option>
                ))}
              </Select>
              {problem && <p className={problem.tone === "err" ? "text-err" : "text-warn"}>{problem.detail}</p>}
            </>
          )}
        </Step>

        <Step n={5} title="用于抓取" state={use} last>
          <p>加入抓取路由后参与所有抓取；用于路由规则时只读取匹配的网站。</p>
          <p className="flex flex-wrap gap-x-3">
            <Link href="/tools/fetch" className="text-ink underline underline-offset-2">
              加入抓取路由
            </Link>
            <Link href="/routing/rules" className="text-ink underline underline-offset-2">
              用于路由规则
            </Link>
          </p>
        </Step>
      </ol>
    </Drawer>
  );
}

function Step({ n, title, state, last, children }: { n: number; title: string; state: StepState; last?: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-x-3">
      <div className="flex flex-col items-center">
        <span
          className={cx(
            "num grid size-7 shrink-0 place-items-center rounded-full border text-xs",
            state.done ? "border-ok/40 bg-ok/10 text-ok" : "border-line-strong text-ink-2",
          )}
        >
          {state.done ? <Check className="size-3.5" /> : n}
        </span>
        {!last && <span className="my-1 w-px flex-1 bg-line" />}
      </div>
      <div className={cx("flex min-w-0 flex-col gap-2.5 text-xs leading-relaxed text-ink-3", !last && "pb-6")}>
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">{title}</span>
          <Badge tone={state.tone} dot={state.tone !== "neutral"}>
            {state.label}
          </Badge>
        </div>
        {children}
      </div>
    </li>
  );
}

/** The sites a fetcher reads through adapters of its own, when a routing rule sends them to it. */
function Adapters({ fetcher, ids }: { fetcher: string; ids: string[] }) {
  const { config, meta } = useConfig();
  const rules = routingRules(config, meta);
  return (
    <ul>
      {ids.map((id) => {
        const rule = meta.rules.find((r) => r.id === id);
        const chosen = rules.find((r) => r.id === id);
        const on = Boolean(chosen?.enabled && chosen.providers.includes(fetcher));
        return (
          <li key={id} className="border-b border-line last:border-b-0">
            <Link href="/routing/rules" className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-ink-2 transition-colors hover:bg-raised/60 hover:text-ink">
              <BrandIcon id={id} className="size-4" />
              <span>{rule?.name ?? id}</span>
              <span className="num min-w-0 flex-1 truncate text-2xs text-ink-3">{rule?.match.join(" ")}</span>
              <Badge tone={on ? "ok" : "neutral"} dot={on}>
                {on ? "已选用" : "未选用"}
              </Badge>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
