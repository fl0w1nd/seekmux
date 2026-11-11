import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { useStatus } from "../components/Health";
import type { api, Config, Fetcher, FetcherWorker, SocialPlatform, SocialSource, WorkerStatus } from "../lib/api";
import { useConfig } from "../lib/config";
import { BrandIcon } from "../ui/brand";
import { Dialog, useConfirm } from "../ui/overlays";
import { Button, Choice, ChoiceList, ChoiceStatus, Empty, Field, Info, NumberInput, Panel, Row, Select, State, Switch, type Tone } from "../ui/primitives";

type GatewayStatus = Awaited<ReturnType<typeof api.status>>;

/** The brand mark of each platform, by its id. */
const platformIcon: Record<string, string> = { x: "twitter" };

/** How a worker can serve a platform now. A worker known to be too old cannot be chosen. */
function workerFit(worker: FetcherWorker, platform: SocialPlatform, status?: WorkerStatus): { tone: Tone; label: string; outdated?: string } {
  if (status?.connected && !(status.features ?? []).includes(platform.feature)) {
    return { tone: "err", label: "版本过低", outdated: `当前 ${status.version || "未知版本"}，需 ${platform.min_worker} 或更高：npx seekmux@latest` };
  }
  if (!worker.enabled) return { tone: "neutral", label: "已停用" };
  if (!status?.connected) return { tone: "warn", label: "离线" };
  if (!status.state?.ready) return { tone: "warn", label: "浏览器未就绪" };
  return { tone: "ok", label: "在线" };
}

/** How a source stands as a whole. */
function sourceState(source: SocialSource, platform: SocialPlatform, config: Config, status?: GatewayStatus): { tone: Tone; label: string } {
  if (!source.enabled) return { tone: "neutral", label: "已停用" };
  const fetcher = config.fetchers.find((f) => f.id === source.fetcher);
  if (!fetcher) return { tone: "warn", label: "未选择抓取器" };
  const chosen = fetcher.workers.filter((w) => source.workers.includes(w.id));
  if (chosen.length === 0) return { tone: "warn", label: "未选择 Worker" };
  const fits = chosen.map((w) => workerFit(w, platform, status?.workers[w.id]));
  if (fits.some((f) => f.tone === "ok")) return { tone: "ok", label: "可用" };
  if (fits.some((f) => f.outdated)) return { tone: "err", label: "Worker 版本过低" };
  return { tone: "warn", label: "离线" };
}

/** The workers of a fetcher a new source starts with: those that can search the platform now. */
function fitting(fetcher: Fetcher | undefined, platform: SocialPlatform, status?: GatewayStatus): string[] {
  return (fetcher?.workers ?? []).filter((w) => workerFit(w, platform, status?.workers[w.id]).tone === "ok").map((w) => w.id);
}

export function SocialPage() {
  const { config, meta, update } = useConfig();
  const status = useStatus();
  const [adding, setAdding] = useState(false);
  const sources = config.social.sources;
  const free = meta.social_platforms.filter((p) => !sources.some((s) => s.platform === p.id));

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title="平台"
        flush
        actions={
          sources.length > 0 &&
          free.length > 0 && (
            <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
              添加
            </Button>
          )
        }
      >
        {sources.length === 0 ? (
          <Empty title="未添加平台">
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              添加平台
            </Button>
          </Empty>
        ) : (
          <ul>
            {sources.map((source, i) => {
              const platform = meta.social_platforms.find((p) => p.id === source.platform);
              return (
                platform && (
                  <SourceItem
                    key={source.platform}
                    source={source}
                    platform={platform}
                    status={status}
                    set={(change) => update((d) => change(d.social.sources[i]))}
                    remove={() => update((d) => void d.social.sources.splice(i, 1))}
                  />
                )
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="行为" flush>
        <Row label="总超时" hint="含排队等待">
          <NumberInput className="w-24" min={1} suffix="秒" value={config.social.timeout_seconds} onChange={(v) => update((d) => void (d.social.timeout_seconds = v))} />
        </Row>
      </Panel>

      {adding && (
        <AddSourceDialog
          platforms={free}
          status={status}
          onClose={() => setAdding(false)}
          onAdd={(source) => {
            update((d) => void d.social.sources.push(source));
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function SourceItem({
  source,
  platform,
  status,
  set,
  remove,
}: {
  source: SocialSource;
  platform: SocialPlatform;
  status?: GatewayStatus;
  set: (change: (s: SocialSource) => void) => void;
  remove: () => void;
}) {
  const { config } = useConfig();
  const confirm = useConfirm();
  const state = sourceState(source, platform, config, status);
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <BrandIcon id={platformIcon[platform.id] ?? platform.id} className="size-4 text-ink" />
        <span className="text-sm font-medium">{platform.name}</span>
        <span className="num text-xs text-ink-3">{platform.tool}</span>
        <State tone={state.tone}>{state.label}</State>
        <span className="ml-auto flex items-center gap-2">
          <Switch checked={source.enabled} onCheckedChange={(enabled) => set((s) => (s.enabled = enabled))} aria-label={`启用 ${platform.name}`} />
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 />}
            aria-label={`移除 ${platform.name}`}
            onClick={async () => {
              if (await confirm({ title: `移除 ${platform.name}？`, body: `${platform.tool} 会从 MCP 工具列表中消失。`, confirm: "移除", danger: true })) remove();
            }}
          />
        </span>
      </div>
      <div className="border-t border-line bg-sunken">
        <Binding
          platform={platform}
          status={status}
          fetcher={source.fetcher}
          workers={source.workers}
          onFetcher={(fetcher, workers) =>
            set((s) => {
              s.fetcher = fetcher;
              s.workers = workers;
            })
          }
          onWorkers={(workers) => set((s) => (s.workers = workers))}
        />
      </div>
    </li>
  );
}

/** The fetcher and the workers of it that search a platform. */
function Binding({
  platform,
  status,
  fetcher: fetcherID,
  workers,
  onFetcher,
  onWorkers,
}: {
  platform: SocialPlatform;
  status?: GatewayStatus;
  fetcher: string;
  workers: string[];
  onFetcher: (fetcher: string, workers: string[]) => void;
  onWorkers: (workers: string[]) => void;
}) {
  const { config } = useConfig();
  const fetchers = config.fetchers.filter((f) => f.type === platform.fetcher_type);
  const fetcher = fetchers.find((f) => f.id === fetcherID);
  const typeName = platform.fetcher_type === "opencli" ? "OpenCLI" : platform.fetcher_type;

  return (
    <>
      <Row label="抓取器" info="搜索与该抓取器的网页抓取共用速率与并发限制">
        {fetchers.length === 0 ? (
          <>
            <span className="text-sm text-ink-3">没有 {typeName} 抓取器</span>
            <Link href="/providers/self" className="text-sm text-ink underline underline-offset-2">
              新建抓取器
            </Link>
          </>
        ) : (
          <Select
            className="w-56"
            value={fetcherID}
            placeholder="选择抓取器"
            aria-label="抓取器"
            onChange={(id) => onFetcher(id, fitting(fetchers.find((f) => f.id === id), platform, status))}
            options={fetchers.map((f) => ({ value: f.id, label: `${typeName} · ${f.name}` }))}
          />
        )}
      </Row>
      {fetcher && (
        <Row label="Worker" align="start" info="按抓取器中的顺序尝试；Worker 离线、忙碌或浏览器不可用时换下一个">
          {fetcher.workers.length === 0 ? (
            <span className="text-sm text-ink-3">该抓取器没有 Worker</span>
          ) : (
            <div className="w-full max-w-md">
              <ChoiceList label={`搜索 ${platform.name} 的 Worker`} multi>
                {fetcher.workers.map((w) => {
                  const fit = workerFit(w, platform, status?.workers[w.id]);
                  const checked = workers.includes(w.id);
                  return (
                    <Choice
                      key={w.id}
                      multi
                      checked={checked}
                      // A worker known to be too old cannot be added; one already chosen can still be taken off.
                      disabled={Boolean(fit.outdated) && !checked}
                      onSelect={() => onWorkers(checked ? workers.filter((id) => id !== w.id) : [...workers, w.id])}
                      title={w.name}
                      status={<ChoiceStatus tone={fit.tone}>{fit.label}</ChoiceStatus>}
                      detail={fit.outdated}
                    />
                  );
                })}
              </ChoiceList>
            </div>
          )}
        </Row>
      )}
    </>
  );
}

function AddSourceDialog({
  platforms,
  status,
  onClose,
  onAdd,
}: {
  platforms: SocialPlatform[];
  status?: GatewayStatus;
  onClose: () => void;
  onAdd: (source: SocialSource) => void;
}) {
  const { config } = useConfig();
  const [platformID, setPlatformID] = useState(platforms[0]?.id ?? "");
  const platform = platforms.find((p) => p.id === platformID);
  const first = config.fetchers.find((f) => f.type === platform?.fetcher_type);
  const [fetcher, setFetcher] = useState(first?.id ?? "");
  const [workers, setWorkers] = useState<string[]>(() => (platform ? fitting(first, platform, status) : []));
  // Judged on every status poll: a worker chosen while offline may since have connected as an older version.
  const usable = platform
    ? (config.fetchers.find((f) => f.id === fetcher)?.workers ?? []).filter((w) => workers.includes(w.id) && !workerFit(w, platform, status?.workers[w.id]).outdated).map((w) => w.id)
    : [];
  const ready = usable.length > 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="添加平台"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!ready} onClick={() => platform && onAdd({ platform: platform.id, enabled: true, fetcher, workers: usable })}>
            添加
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="平台">
          <ChoiceList label="平台">
            {platforms.map((p) => (
              <Choice
                key={p.id}
                checked={p.id === platformID}
                onSelect={() => setPlatformID(p.id)}
                title={
                  <span className="flex items-center gap-2">
                    <BrandIcon id={platformIcon[p.id] ?? p.id} className="size-3.5 text-ink" />
                    {p.name}
                  </span>
                }
              />
            ))}
          </ChoiceList>
        </Field>
        {platform && (
          <div className="-mx-4 border-y border-line">
            <Binding
              platform={platform}
              status={status}
              fetcher={fetcher}
              workers={workers}
              onFetcher={(id, ws) => {
                setFetcher(id);
                setWorkers(ws);
              }}
              onWorkers={setWorkers}
            />
          </div>
        )}
        {platform && fetcher && usable.length === 0 && (
          <p className="flex items-center gap-1 text-xs text-ink-3">
            至少选择一个 Worker
            <Info label="Worker 说明">搜索 {platform.name} 需要 seekmux Worker {platform.min_worker} 或更高版本，且 Chrome Profile 已登录该平台</Info>
          </p>
        )}
      </div>
    </Dialog>
  );
}
