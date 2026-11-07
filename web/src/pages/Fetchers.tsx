import { ArrowDown, ArrowUp, ExternalLink, Plus, Puzzle, RefreshCw, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { Tripped, useStatus } from "../components/Health";
import type { Config, Fetcher, FetcherWorker, Meta, WorkerProfile, WorkerStatus } from "../lib/api";
import { useConfig } from "../lib/config";
import { routingRules } from "../lib/routing";
import { PageHeader } from "../Shell";
import { BrandIcon } from "../ui/brand";
import { RateLimitInput } from "../ui/inputs";
import { Dialog, Popover, useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, Choice, ChoiceList, CodeBlock, Empty, Field, Input, Notice, NumberInput, Panel, Select, Switch, type Tone } from "../ui/primitives";
import { CardRow } from "./Providers";

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

/** Self-hosted fetchers: workers on the user's own devices, each fetcher one provider to the routes. */
export function FetchersPage() {
  const { config, update, meta } = useConfig();
  const [creating, setCreating] = useState(false);
  // A token generated here is shown in its worker's command until the page
  // is left; the saved one comes back only as a hint.
  const [fresh, setFresh] = useState<Record<string, string>>({});
  const remember = (worker: FetcherWorker) => setFresh((f) => ({ ...f, [worker.id]: worker.token }));

  return (
    <>
      <PageHeader
        title="自托管抓取器"
        description="在自己的设备上运行 Worker，用已登录的浏览器读取其他提供商读不到的页面。每个抓取器对路由来说是一个提供商；抓取按顺序交给第一个能接手的 Worker，Worker 离线、任务已满或自身出错时才交给下一个。"
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            新建抓取器
          </Button>
        }
      />
      {config.fetchers.length === 0 ? (
        <Panel>
          <Empty icon={<Server />} title="尚无自托管抓取器">
            新建一个抓取器，再在装有 Chrome 的设备上运行它的 Worker。
          </Empty>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {config.fetchers.map((fetcher, index) => (
            <FetcherPanel key={fetcher.id} fetcher={fetcher} index={index} fresh={fresh} remember={remember} />
          ))}
        </div>
      )}
      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={(type, name) => {
          const worker = newWorker(1);
          remember(worker);
          update((d) => {
            d.fetchers.push({ id: newFetcherID(d, meta, type.id), type: type.id, name, rate_limit: type.default_rate_limit, concurrency: 0, workers: [worker] });
          });
          setCreating(false);
        }}
      />
    </>
  );
}

function CreateDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (type: Meta["fetcher_types"][number], name: string) => void }) {
  const { meta } = useConfig();
  const [type, setType] = useState(meta.fetcher_types[0]?.id ?? "");
  const [name, setName] = useState("");
  const chosen = meta.fetcher_types.find((t) => t.id === type);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="新建抓取器"
      description="创建后会附带一个 Worker 及其令牌；之后可以继续添加 Worker 并调整顺序。"
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
              detail={t.id === "opencli" ? "通过 OpenCLI 扩展驱动已登录的 Chrome；X、Reddit 等站点有专属适配器。" : undefined}
            />
          ))}
        </ChoiceList>
        <Field label="名称" hint="在路由、规则和日志中显示。">
          <Input value={name} placeholder={chosen?.name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function FetcherPanel({
  fetcher,
  index,
  fresh,
  remember,
}: {
  fetcher: Fetcher;
  index: number;
  fresh: Record<string, string>;
  remember: (worker: FetcherWorker) => void;
}) {
  const { config, update, meta } = useConfig();
  const status = useStatus();
  const confirm = useConfirm();
  const toast = useToast();
  const type = meta.fetcher_types.find((t) => t.id === fetcher.type);
  const set = (change: (f: Fetcher) => void) =>
    update((d) => {
      const f = d.fetchers.find((x) => x.id === fetcher.id);
      if (f) change(f);
    });
  const health = status?.routes.find((r) => r.key === `${fetcher.id}:fetch`);
  const usable = fetcher.workers.filter((w) => workerState(w, status?.workers[w.id]).usable).length;
  const enabled = fetcher.workers.filter((w) => w.enabled).length;
  const route = config.fetch.routes.find((r) => r.provider === fetcher.id);
  const rules = routingRules(config, meta).filter((r) => r.enabled && r.providers.includes(fetcher.id));
  const used = Boolean(route?.enabled) || rules.length > 0;

  const remove = async () => {
    const only = config.routing.rules.filter((r) => r.providers.length === 1 && r.providers[0] === fetcher.id);
    if (only.length > 0) {
      toast(`规则「${only.map((r) => r.name).join("」「")}」只用这个抓取器，先在服务路由中为其换用其他提供商`, "err");
      return;
    }
    const ok = await confirm({
      title: `删除抓取器 ${fetcher.name}？`,
      body: "它的 Worker 随之断开，令牌失效；抓取路由与服务路由中对它的引用一并移除。立即生效。",
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
  };

  return (
    <Panel
      flush
      index={String(index + 1).padStart(2, "0")}
      title={
        <span className="flex items-center gap-2 self-center">
          <BrandIcon id={fetcher.type} className="size-4" />
          <span>{fetcher.name}</span>
          {health?.disabled ? (
            <Tripped id={health.key} health={health} />
          ) : enabled === 0 ? (
            <Badge>未启用 Worker</Badge>
          ) : usable > 0 ? (
            <Badge tone="ok" dot>
              {usable}/{enabled} 可用
            </Badge>
          ) : (
            <Badge tone="warn" dot>
              无可用 Worker
            </Badge>
          )}
        </span>
      }
      actions={
        <>
          <Badge>{type?.name ?? fetcher.type}</Badge>
          <span className="num text-2xs text-ink-3">{fetcher.id}</span>
          {type?.adapters && type.adapters.length > 0 && <Adapters ids={type.adapters} />}
          {type?.website && (
            <a href={type.website} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink">
              项目 <ExternalLink className="size-3" />
            </a>
          )}
          <Button size="sm" variant="ghost" icon={<Trash2 />} aria-label={`删除 ${fetcher.name}`} onClick={remove} />
        </>
      }
    >
      {!used && (
        <div className="border-b border-line p-3.5">
          <Notice tone="info">
            尚未投入使用：在{" "}
            <Link href="/tools/fetch" className="text-ink underline underline-offset-2">
              网页抓取的路由
            </Link>{" "}
            中启用它作为兜底，或在{" "}
            <Link href="/routing/rules" className="text-ink underline underline-offset-2">
              服务路由
            </Link>{" "}
            的规则中选用它。
          </Notice>
        </div>
      )}

      <CardRow label="名称">
        <Input value={fetcher.name} maxLength={64} aria-label="抓取器名称" onChange={(e) => set((f) => (f.name = e.target.value))} />
      </CardRow>

      <CardRow label="配额限流" aside="所有 Worker 共用">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <RateLimitInput value={fetcher.rate_limit} fallback={type?.default_rate_limit} onChange={(rate_limit) => set((f) => (f.rate_limit = rate_limit))} />
          <div className="flex items-center gap-1.5 text-xs text-ink-3">
            <span>并发</span>
            <NumberInput
              className="w-20"
              min={0}
              suffix={fetcher.concurrency === 0 ? "不限" : undefined}
              value={fetcher.concurrency}
              onChange={(concurrency) => set((f) => (f.concurrency = Math.max(0, Math.round(concurrency))))}
              aria-label={`${fetcher.name} 并发上限`}
            />
          </div>
        </div>
      </CardRow>

      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div>
          <div className="text-xs font-medium text-ink-2">Worker</div>
          <div className="text-2xs text-ink-3">按顺序接手抓取；前一个离线、任务已满或出错时才交给下一个。并发由各 Worker 的 --slots 决定。</div>
        </div>
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
            regenerate={() => {
              const token = newToken();
              remember({ ...worker, token });
              set((f) => (f.workers[i].token = token));
            }}
            remove={() => set((f) => f.workers.splice(i, 1))}
          />
        ))}
      </ol>
    </Panel>
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
}) {
  const { config } = useConfig();
  const confirm = useConfirm();
  const state = workerState(worker, status);
  const connected = status?.connected ? status : undefined;
  const profiles = connected?.state?.profiles ?? [];
  const chosen = worker.profile ?? "";
  const problem = connected?.state?.ready ? profileProblem(profiles, chosen) : undefined;
  const server = config.network.public_url || window.location.origin;
  const command = `npx seekmux --server ${server} --token ${token ?? "<Worker 令牌>"}`;

  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <span className={state.usable ? "num w-6 text-sm text-signal-text" : "num w-6 text-sm text-ink-3"}>{String(index + 1).padStart(2, "0")}</span>
        <span className="flex flex-col">
          <Button size="sm" variant="ghost" className="h-4" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(-1)} />
          <Button size="sm" variant="ghost" className="h-4" icon={<ArrowDown />} aria-label="下移" disabled={index === count - 1} onClick={() => move(1)} />
        </span>
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

      <div className="grid grid-cols-1 gap-x-4 gap-y-2 px-4 pb-3 sm:grid-cols-[4.5rem_1fr] sm:pl-[4.75rem]">
        <span className="self-center text-xs font-medium text-ink-2">令牌</span>
        <div className="flex min-w-0 items-center gap-2">
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
                (await confirm({ title: `重新生成 ${worker.name} 的令牌？`, body: "已连接的 Worker 会立即断开，需换用新令牌重新运行。", confirm: "重新生成", danger: true }));
              if (ok) regenerate();
            }}
          />
        </div>

        {!connected && (
          <>
            <span className="self-start pt-2 text-xs font-medium text-ink-2">运行</span>
            <div className="flex min-w-0 flex-col gap-1.5">
              <CodeBlock copy wrap>
                {command}
              </CodeBlock>
              <span className="text-2xs text-ink-3">
                {token ? "在装有 Chrome 和 OpenCLI 扩展的设备上运行。" : "已保存的令牌不再显示；忘记时可重新生成，旧令牌随之失效。"}
              </span>
            </div>
          </>
        )}

        <span className="self-center text-xs font-medium text-ink-2">Profile</span>
        <div className="flex min-w-0 flex-col gap-1.5">
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

/** The sites a fetcher reads through adapters of its own, when a routing rule sends them to it. */
function Adapters({ ids }: { ids: string[] }) {
  const { meta } = useConfig();
  return (
    <Popover
      align="end"
      className="w-72"
      trigger={
        <Button size="sm" variant="ghost" icon={<Puzzle />}>
          能力
        </Button>
      }
    >
      <div className="p-3.5">
        <div className="text-xs font-medium text-ink">专属适配器</div>
        <p className="mt-1 text-xs text-ink-3">
          服务路由把这些站点的帖子交给它时，用站点适配器读取正文与完整的评论回复；其他页面，以及抓取路由中的兜底，按页面渲染结果读取。
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          {ids.map((id) => {
            const rule = meta.rules.find((r) => r.id === id);
            return (
              <Link key={id} href="/routing/rules" className="flex items-center gap-2 rounded-ctl px-2 py-1.5 text-sm text-ink-2 transition-colors hover:bg-sunken hover:text-ink">
                <BrandIcon id={id} className="size-3.5" />
                <span>{rule?.name ?? id}</span>
                <span className="num ml-auto truncate text-2xs text-ink-3">{rule?.match.join(" ")}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </Popover>
  );
}
