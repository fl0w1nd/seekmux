import { ExternalLink, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { ProviderNames } from "../../components/ProviderName";
import { api, type SearchArgs, type SearchResult } from "../../lib/api";
import { useConfig } from "../../lib/config";
import { duration } from "../../lib/format";
import { useElapsed } from "../../lib/motion";
import { usePlay } from "../../lib/trace";
import { ChipInput } from "../../ui/inputs";
import { Badge, cx, Dot, Empty, Notice, NumberInput, Segmented } from "../../ui/primitives";
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

// The limits of the search tool (search.MaxQueries, search.MaxDomains, maxResults).
const maxQueries = 3;
const maxDomains = 10;
const maxResultsLimit = 100;
export const defaultMaxResults = 5;

const ranges = [
  { value: "", label: "不限" },
  { value: "day", label: "一天" },
  { value: "week", label: "一周" },
  { value: "month", label: "一月" },
  { value: "year", label: "一年" },
];

const domain = (text: string) =>
  text
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");

export function SearchPlay() {
  const { config, provider } = useConfig();
  const [text, setText] = useState("");
  const [maxResults, setMaxResults] = useState(defaultMaxResults);
  const [range, setRange] = useState("");
  const [engine, setEngine] = useState("auto");
  const [include, setInclude] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<"visual" | "json">("visual");
  const [inspected, setInspected] = useState<InspectedRun<SearchResult[]> | null>(null);
  const tuning = useTuning("search", engine);
  const run = usePlay(api.playSearch);
  const views = useRunView(run.pending);
  const elapsed = useElapsed(run.pending);

  const queries = text
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
  const over = queries.length > maxQueries;
  const args: SearchArgs = { queries: queries.slice(0, maxQueries) };
  if (maxResults !== defaultMaxResults) args.maxResults = maxResults;
  if (range) args.time_range = range;
  if (include.length > 0) args.include_domains = include;
  if (exclude.length > 0) args.exclude_domains = exclude;
  if (engine !== "auto") args.search_engine = engine;

  const ready = queries.length > 0 && !over;
  const submit = () => {
    if (!ready || run.pending) return;
    setInspected(null);
    views.begin();
    run.start({ ...args, route: tuning.route });
  };

  const restore = (request: Record<string, unknown>) => {
    const pinned = typeof request.search_engine === "string" ? request.search_engine : "auto";
    setText(words(request.queries).join("\n"));
    setMaxResults(typeof request.maxResults === "number" ? request.maxResults : defaultMaxResults);
    setRange(ranges.some((r) => r.value === request.time_range) ? (request.time_range as string) : "");
    setInclude(words(request.include_domains));
    setExclude(words(request.exclude_domains));
    // A provider switched off since then cannot be pinned again.
    setEngine(config.search.routes.some((r) => r.enabled && r.provider === pinned) ? pinned : "auto");
  };

  const rerun = () => {
    if (run.pending) return;
    if (inspected?.request) {
      const req = inspected.request;
      restore(req);
      const pinned = typeof req.search_engine === "string" ? req.search_engine : "auto";
      const nextEngine = config.search.routes.some((r) => r.enabled && r.provider === pinned) ? pinned : "auto";
      const nextQueries = words(req.queries).slice(0, maxQueries);
      if (nextQueries.length === 0) return;
      const nextArgs: SearchArgs = { queries: nextQueries };
      const nextMax = typeof req.maxResults === "number" ? req.maxResults : defaultMaxResults;
      if (nextMax !== defaultMaxResults) nextArgs.maxResults = nextMax;
      if (ranges.some((r) => r.value === req.time_range) && req.time_range) nextArgs.time_range = req.time_range as string;
      const inc = words(req.include_domains);
      const exc = words(req.exclude_domains);
      if (inc.length > 0) nextArgs.include_domains = inc;
      if (exc.length > 0) nextArgs.exclude_domains = exc;
      if (nextEngine !== "auto") nextArgs.search_engine = nextEngine;
      setInspected(null);
      views.begin();
      run.start(nextArgs);
      return;
    }
    submit();
  };

  const hasDomainFilter = include.length > 0 || exclude.length > 0;
  const domainSummary = [include.length > 0 && `限定 ${include.length} 域名`, exclude.length > 0 && `排除 ${exclude.length} 域名`].filter(Boolean).join(" · ");

  const data = run.data;
  const activeResults = inspected ? inspected.response : data?.results;
  const activeDuration = inspected ? inspected.entry.duration_ms : (data?.duration_ms ?? 0);
  const found = activeResults?.reduce((n, r) => n + (r.web?.length ?? 0) + (r.videos?.length ?? 0), 0) ?? 0;
  const engines = inspected
    ? (inspected.entry.provider ? inspected.entry.provider.split(",") : [])
    : [...new Set(data?.results.map((r) => r.search_engine).filter((e): e is string => Boolean(e)))];

  return (
    <Stage
      tool="search"
      title="网页搜索"
      history={
        <Recent<SearchResult[]>
          tool="search"
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
            activeResults && (
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
                {engines.length > 0 && <ProviderNames ids={engines.join(",")} />}
                {activeResults && (
                  <span>
                    {activeResults.length} 条查询 · {found} 条结果
                  </span>
                )}
                {!inspected && run.variables?.route && <Badge>临时参数</Badge>}
              </>
            )
          }
        >
          {inspected ? (
            !inspected.response ? (
              <HistoricalFallback entry={inspected.entry} request={inspected.request} onRerun={rerun} />
            ) : format === "json" ? (
              <JSONView value={inspected.response} />
            ) : (
              <SearchResults key={inspected.entry.id} results={inspected.response} />
            )
          ) : run.pending ? (
            <Waiting label={run.variables?.queries.join(" · ")} elapsed={elapsed} />
          ) : run.error ? (
            <Failure error={run.error} />
          ) : data && format === "json" ? (
            <JSONView value={data.results} />
          ) : (
            data && <SearchResults key={run.submittedAt} results={data.results} />
          )}
        </Output>
      }
    >
      <Composer
        open={open}
        tools={
          <>
            <ProviderChip tool="search" value={engine} onChange={setEngine} changed={tuning.changed} />
            <div className="flex items-center gap-1.5 text-xs text-ink-3">
              <span>每条</span>
              <NumberInput
                className="w-20"
                min={1}
                suffix="条"
                value={maxResults}
                aria-label="每条查询的结果数"
                onChange={(v) => setMaxResults(Math.min(maxResultsLimit, Math.max(1, Math.round(v))))}
              />
            </div>
            <Segmented size="sm" value={range} onChange={setRange} options={ranges} />
          </>
        }
        toolbarRight={
          <>
            {domainSummary && <Summary onClick={() => setOpen(true)}>{domainSummary}</Summary>}
            <Chip
              icon={<SlidersHorizontal />}
              label="域名与参数"
              changed={hasDomainFilter || tuning.changed}
              aria-expanded={open}
              aria-pressed={open}
              onClick={() => setOpen(!open)}
            />
            <CodeButton
              tool="search"
              args={args}
              notices={
                <>
                  {over && (
                    <Notice tone="warn">
                      只执行前 {maxQueries} 条查询
                    </Notice>
                  )}
                  <LocalNotice items={[tuning.changed && `${provider(engine).name} 的临时参数`]} />
                </>
              }
            />
          </>
        }
        panel={
          <>
            <OptionGroup
              title="域名过滤"
              action={
                hasDomainFilter && (
                  <ResetButton
                    label="清空域名"
                    onClick={() => {
                      setInclude([]);
                      setExclude([]);
                    }}
                  />
                )
              }
            >
              <div className="grid gap-4 @2xl:grid-cols-2">
                <Group label="限定域名" hint="含子域名">
                  <ChipInput value={include} onChange={setInclude} max={maxDomains} normalize={domain} placeholder="docs.python.org" aria-label="限定域名" />
                </Group>
                <Group label="排除域名" hint="含子域名">
                  <ChipInput value={exclude} onChange={setExclude} max={maxDomains} normalize={domain} placeholder="pinterest.com" aria-label="排除域名" />
                </Group>
              </div>
            </OptionGroup>
            <ProviderParams tool="search" engine={engine} tuning={tuning} />
          </>
        }
        footer={
          <>
            <Examples
              items={["mcp streamable http spec", "go 1.27 release notes", "sqlite wal mode performance"]}
              current={text}
              onPick={setText}
              onClear={() => setText("")}
            />
            {queries.length > 0 && (
              <span className={cx("num ml-auto text-xs", over ? "font-medium text-err" : "text-ink-3")}>
                {queries.length} / {maxQueries} 条查询{over && "（超出上限）"}
              </span>
            )}
          </>
        }
        actions={<RunButton label="搜索" loading={run.pending} disabled={!ready} onClick={submit} onStop={run.stop} />}
      >
        <div className="flex items-start px-3.5 py-2.5">
          <span className="tag w-12 shrink-0 pt-1 text-ink-3">查询</span>
          <textarea
            rows={3}
            value={text}
            spellCheck={false}
            aria-label="查询"
            placeholder="每行一条查询词，最多 3 条并行检索"
            className="num min-w-0 flex-1 resize-none bg-transparent text-sm leading-6 text-ink placeholder:text-ink-3 focus:outline-none"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onModEnter(submit)}
          />
        </div>
      </Composer>
    </Stage>
  );
}

/** Brave words the age of a result; Exa gives a timestamp, of which the date is enough. */
const age = (text: string) => (/^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text);

function SearchResults({ results }: { results: SearchResult[] }) {
  const [index, setIndex] = useState(0);
  const current = results[Math.min(index, results.length - 1)];
  return (
    <>
      {results.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-line px-4 py-2">
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
              className={cx(
                "press inline-flex h-7 max-w-72 shrink-0 items-center gap-1.5 rounded-ctl px-2.5 text-xs",
                i === index ? "bg-fill-strong text-ink" : "bg-fill text-ink-2 hover:text-ink",
              )}
            >
              <span className="truncate">{r.query}</span>
              {r.error ? <Dot tone="err" /> : <span className="num text-ink-3">{(r.web?.length ?? 0) + (r.videos?.length ?? 0)}</span>}
            </button>
          ))}
        </div>
      )}
      {current && <QueryResult result={current} />}
    </>
  );
}

function QueryResult({ result }: { result: SearchResult }) {
  const web = result.web ?? [];
  const items = [...web, ...(result.videos ?? [])];
  if (result.error) {
    return (
      <div className="p-4">
        <ResultError error={result.error}>
          <span className="font-medium text-ink">{result.query}</span>：
        </ResultError>
      </div>
    );
  }
  if (items.length === 0) return <Empty title="该查询没有结果" />;
  return (
    <ol className="divide-y divide-line">
      {items.map((item, i) => (
        <li key={`${item.url}-${i}`} className="flex gap-3 px-4 py-3">
          <span className="tag w-5 shrink-0 pt-0.5">{String(i + 1).padStart(2, "0")}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs text-ink-3">
              <span className="num truncate text-ink-2">{host(item.url)}</span>
              {i >= web.length && <Badge>视频</Badge>}
              {item.age && <span className="shrink-0">{age(item.age)}</span>}
              {item.duration && <span className="num shrink-0">{item.duration}</span>}
              {item.score !== undefined && <span className="num ml-auto shrink-0">相关度 {item.score.toFixed(2)}</span>}
            </div>
            <a href={item.url} target="_blank" rel="noreferrer" title={item.url} className="group mt-0.5 flex items-center gap-1.5 text-sm font-medium hover:text-signal-text">
              <span className="truncate">{item.title || item.url}</span>
              <ExternalLink className="size-3 shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
            </a>
            {item.description ? (
              <p className="mt-1 line-clamp-4 text-xs whitespace-pre-line text-ink-2">{item.description}</p>
            ) : (
              <p className="mt-1 text-xs text-ink-3">提供商未返回摘要</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
