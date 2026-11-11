import { ExternalLink, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { ProviderNames } from "../../components/ProviderName";
import { api, type DevSearchArgs, type DevSearchItem, type DevSearchResult } from "../../lib/api";
import { useConfig } from "../../lib/config";
import { duration } from "../../lib/format";
import { useElapsed } from "../../lib/motion";
import { usePlay } from "../../lib/trace";
import { ChipInput } from "../../ui/inputs";
import { Markdown } from "../../ui/markdown";
import { Badge, cx, Empty, NumberInput, Segmented } from "../../ui/primitives";
import {
  Chip,
  CodeButton,
  Composer,
  Examples,
  Failure,
  Group,
  HistoricalFallback,
  HistoryBanner,
  host,
  type InspectedRun,
  JSONView,
  LocalNotice,
  onModEnter,
  OptionGroup,
  Output,
  ProviderChip,
  ProviderParams,
  Recent,
  ResetButton,
  ResultError,
  RunButton,
  Stage,
  Summary,
  useRunView,
  useTuning,
  Waiting,
  words,
} from "./kit";
import { defaultMaxResults } from "./Search";

// The limits of the dev_search tool (search.DevMaxResults, search.DevMaxRepos).
const devMaxResults = 20;
const devMaxRepos = 10;

const devTypes = [
  { value: "doc", label: "文档" },
  { value: "issue", label: "Issue" },
  { value: "pull_request", label: "PR" },
  { value: "readme", label: "README" },
];
const devTypeLabel: Record<string, string> = Object.fromEntries(devTypes.map((t) => [t.value, t.label]));

const repo = (text: string) =>
  text
    .replace(/^.*github\.com\//, "")
    .replace(/\.git$/, "")
    .split("/")
    .slice(0, 2)
    .join("/");

export function DevSearchPlay() {
  const { provider } = useConfig();
  const [query, setQuery] = useState("");
  const [maxResults, setMaxResults] = useState(defaultMaxResults);
  const [types, setTypes] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [engine, setEngine] = useState("auto");
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<"visual" | "json">("visual");
  const [inspected, setInspected] = useState<InspectedRun<DevSearchResult> | null>(null);
  const tuning = useTuning("dev_search", engine);
  const run = usePlay(api.playDevSearch);
  const views = useRunView(run.pending);
  const elapsed = useElapsed(run.pending);

  const args: DevSearchArgs = { query: query.trim() };
  if (maxResults !== defaultMaxResults) args.maxResults = maxResults;
  if (types.length > 0) args.types = types;
  if (repos.length > 0) args.repos = repos;

  const ready = args.query !== "";
  const submit = () => {
    if (!ready || run.pending) return;
    setInspected(null);
    views.begin();
    run.start({ ...args, search_engine: engine === "auto" ? undefined : engine, route: tuning.route });
  };

  const restore = (request: Record<string, unknown>) => {
    setQuery(typeof request.query === "string" ? request.query : "");
    setMaxResults(typeof request.maxResults === "number" ? request.maxResults : defaultMaxResults);
    setTypes(words(request.types).filter((t) => t in devTypeLabel));
    setRepos(words(request.repos));
  };

  const rerun = () => {
    if (run.pending) return;
    if (inspected?.request) {
      const req = inspected.request;
      restore(req);
      const q = typeof req.query === "string" ? req.query.trim() : "";
      if (!q) return;
      const nextArgs: DevSearchArgs = { query: q };
      const nextMax = typeof req.maxResults === "number" ? req.maxResults : defaultMaxResults;
      if (nextMax !== defaultMaxResults) nextArgs.maxResults = nextMax;
      const nextTypes = words(req.types).filter((t) => t in devTypeLabel);
      if (nextTypes.length > 0) nextArgs.types = nextTypes;
      const nextRepos = words(req.repos);
      if (nextRepos.length > 0) nextArgs.repos = nextRepos;
      setInspected(null);
      views.begin();
      run.start({ ...nextArgs, search_engine: engine === "auto" ? undefined : engine, route: tuning.route });
      return;
    }
    submit();
  };

  const data = run.data;
  const activeResult = inspected ? inspected.response : data?.result;
  const activeDuration = inspected ? inspected.entry.duration_ms : (data?.duration_ms ?? 0);
  const activeEngine = inspected ? inspected.entry.provider : data?.result.search_engine;

  return (
    <Stage
      tool="dev_search"
      title="开发搜索"
      history={
        <Recent<DevSearchResult>
          tool="dev_search"
          stamp={run.pending ? undefined : run.submittedAt || undefined}
          activeId={inspected?.entry.id}
          onPick={restore}
          onInspect={(item) => {
            setInspected(item);
            views.show("result");
          }}
        />
      }
      output={
        <Output
          run={run}
          inspected={inspected}
          view={views.view}
          onView={views.pick}
          banner={
            inspected && (
              <HistoryBanner
                entry={inspected.entry}
                onRestore={inspected.request ? () => restore(inspected.request!) : undefined}
                onRerun={rerun}
                onClose={() => setInspected(null)}
              />
            )
          }
          actions={
            views.view === "result" &&
            activeResult &&
            !activeResult.error && (
              <Segmented
                size="sm"
                value={format}
                onChange={setFormat}
                options={[
                  { value: "visual", label: "可视" },
                  { value: "json", label: "JSON" },
                ]}
              />
            )
          }
          strip={
            (inspected || data) && (
              <>
                <span className="num font-medium text-ink">{duration(activeDuration)}</span>
                {activeEngine && <ProviderNames ids={activeEngine} />}
                {activeResult?.results && <span>{activeResult.results.length} 条结果</span>}
                {!inspected && run.variables?.route && <Badge>临时参数</Badge>}
              </>
            )
          }
        >
          {!inspected && run.pending ? (
            <Waiting label={run.variables?.query} elapsed={elapsed} />
          ) : !inspected && run.error ? (
            <Failure error={run.error} />
          ) : inspected && !inspected.response ? (
            <HistoricalFallback entry={inspected.entry} request={inspected.request} onRerun={rerun} />
          ) : activeResult?.error ? (
            <div className="p-4">
              <ResultError error={activeResult.error} />
            </div>
          ) : activeResult && format === "json" ? (
            <JSONView value={activeResult} />
          ) : (
            activeResult && <DevResults key={inspected ? inspected.entry.id : run.submittedAt} items={activeResult.results ?? []} />
          )}
        </Output>
      }
    >
      <Composer
        open={open}
        tools={
          <>
            <ProviderChip tool="dev_search" value={engine} onChange={setEngine} changed={tuning.changed} />
            <div className="flex items-center gap-1.5 text-xs text-ink-3">
              <span>结果</span>
              <NumberInput
                className="w-20"
                min={1}
                suffix="条"
                value={maxResults}
                aria-label="结果数"
                onChange={(v) => setMaxResults(Math.min(devMaxResults, Math.max(1, Math.round(v))))}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="结果类型">
              {devTypes.map((type) => {
                const on = types.includes(type.value);
                return (
                  <button
                    key={type.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTypes(on ? types.filter((t) => t !== type.value) : [...types, type.value])}
                    className={cx(
                      "press flex h-7 items-center rounded-ctl px-2.5 text-xs",
                      on ? "bg-signal/25 text-ink hover:bg-signal/35" : "bg-fill text-ink-2 hover:bg-fill-strong hover:text-ink",
                    )}
                  >
                    {type.label}
                  </button>
                );
              })}
            </div>
          </>
        }
        toolbarRight={
          <>
            {repos.length > 0 && <Summary onClick={() => setOpen(true)}>限定 {repos.length} 个仓库</Summary>}
            <Chip
              icon={<SlidersHorizontal />}
              label="仓库与参数"
              changed={repos.length > 0 || tuning.changed}
              aria-expanded={open}
              aria-pressed={open}
              onClick={() => setOpen(!open)}
            />
            <CodeButton
              tool="dev_search"
              args={args}
              notices={<LocalNotice items={[engine !== "auto" && `固定提供商 ${provider(engine).name}`, tuning.changed && `${provider(engine).name} 的临时参数`]} />}
            />
          </>
        }
        panel={
          <>
            <OptionGroup
              title="仓库过滤"
              action={repos.length > 0 && <ResetButton label="清空仓库" onClick={() => setRepos([])} />}
            >
              <Group label="限定仓库" info="只检索这些 GitHub 仓库的 Issue、PR 与 README，对文档站结果无效">
                <ChipInput value={repos} onChange={setRepos} max={devMaxRepos} normalize={repo} placeholder="modelcontextprotocol/go-sdk" aria-label="限定仓库" />
              </Group>
            </OptionGroup>
            <ProviderParams tool="dev_search" engine={engine} tuning={tuning} />
          </>
        }
        footer={
          <Examples
            items={["go-sdk streamable http stateless mode behind a reverse proxy", "sqlite busy_timeout with WAL mode", "vite proxy websocket not forwarded"]}
            current={query}
            onPick={setQuery}
            onClear={() => setQuery("")}
          />
        }
        actions={<RunButton label="搜索" loading={run.pending} disabled={!ready} onClick={submit} onStop={run.stop} />}
      >
        <div className="flex items-start px-3.5 py-2.5">
          <span className="tag w-12 shrink-0 pt-1 text-ink-3">问题</span>
          <textarea
            rows={3}
            value={query}
            spellCheck={false}
            aria-label="问题"
            placeholder="用自然语言描述技术问题，并写明库或框架的名称"
            className="min-w-0 flex-1 resize-none bg-transparent text-sm leading-6 text-ink placeholder:text-ink-3 focus:outline-none"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onModEnter(submit)}
          />
        </div>
      </Composer>
    </Stage>
  );
}

function DevResults({ items }: { items: DevSearchItem[] }) {
  if (items.length === 0) return <Empty title="没有结果" />;
  return (
    <ol className="divide-y divide-line">
      {items.map((item, i) => (
        <li key={`${item.url}-${i}`} className="flex gap-3 px-4 py-3">
          <span className="tag w-5 shrink-0 pt-0.5">{String(i + 1).padStart(2, "0")}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs text-ink-3">
              {item.type && <Badge>{devTypeLabel[item.type] ?? item.type}</Badge>}
              <span className="num truncate text-ink-2">{host(item.url)}</span>
            </div>
            <a href={item.url} target="_blank" rel="noreferrer" title={item.url} className="group mt-0.5 flex items-center gap-1.5 text-sm font-medium hover:text-signal-text">
              <span className="truncate">{item.title || item.url}</span>
              <ExternalLink className="size-3 shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
            </a>
            {item.passages?.map((passage, n) => (
              <div key={n} className="mt-2 max-h-72 overflow-y-auto rounded-ctl bg-sunken px-3 py-2 text-xs">
                <Markdown>{passage}</Markdown>
              </div>
            )) ?? <p className="mt-1 text-xs text-ink-3">提供商未返回匹配段落</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
