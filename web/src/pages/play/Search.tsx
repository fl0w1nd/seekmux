import { useMutation } from "@tanstack/react-query";
import { ExternalLink, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { api, type SearchArgs, type SearchResult } from "../../lib/api";
import { useConfig } from "../../lib/config";
import { duration } from "../../lib/format";
import { useElapsed } from "../../lib/motion";
import { ChipInput } from "../../ui/inputs";
import { Badge, cx, Dot, Empty, Notice, NumberInput, Segmented } from "../../ui/primitives";
import {
  bare,
  Chip,
  CodeButton,
  Composer,
  Examples,
  Failure,
  Group,
  host,
  JSONView,
  LocalNotice,
  onModEnter,
  OptionGroup,
  Output,
  ProviderChip,
  ProviderParams,
  Recent,
  RunButton,
  Stage,
  Summary,
  TabPanel,
  traceLabel,
  TraceView,
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
  { value: "month", label: "一个月" },
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
  const [view, setView] = useState<"result" | "trace">("result");
  const [format, setFormat] = useState<"visual" | "json">("visual");
  const tuning = useTuning("search", engine);
  const run = useMutation({ mutationFn: api.playSearch });
  const elapsed = useElapsed(run.isPending);

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
    if (!ready || run.isPending) return;
    setView("result");
    run.mutate({ ...args, route: tuning.route });
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

  const data = run.data;
  const found = data?.results.reduce((n, r) => n + (r.web?.length ?? 0) + (r.videos?.length ?? 0), 0) ?? 0;
  const engines = [...new Set(data?.results.map((r) => r.search_engine).filter(Boolean))];
  const filters = [include.length > 0 && `限定 ${include.length} 个域名`, exclude.length > 0 && `排除 ${exclude.length} 个域名`].filter(Boolean);

  return (
    <>
      <Stage title="搜索网页" description="调用 search 工具。路由、限流与故障转移均与 MCP 调用一致，调用记入请求日志。">
        <Composer
          open={open}
          tools={
            <>
              <Chip icon={<SlidersHorizontal />} label="参数" aria-pressed={open} onClick={() => setOpen(!open)} />
              <ProviderChip tool="search" value={engine} onChange={setEngine} changed={tuning.changed} />
              <Summary onClick={() => setOpen(true)}>{[`${maxResults} 条`, range ? `近${ranges.find((r) => r.value === range)?.label}` : "时间不限", ...filters].join(" · ")}</Summary>
            </>
          }
          actions={
            <>
              <CodeButton
                tool="search"
                args={args}
                notices={
                  <>
                    {over && (
                      <Notice tone="warn">
                        已输入 {queries.length} 条查询，单次调用最多执行 {maxQueries} 条。Agent 以相同参数调用时，超出部分将被忽略，因此此处仅列出实际执行的前 {maxQueries} 条。
                      </Notice>
                    )}
                    <LocalNotice items={[tuning.changed && `${provider(engine).name} 的临时参数`]} />
                  </>
                }
              />
              <RunButton label="搜索" loading={run.isPending} disabled={!ready} onClick={submit} />
            </>
          }
          panel={
            <>
              <OptionGroup title="调用参数">
                <Group label="每条查询的结果数" hint={`1–${maxResultsLimit}，默认 ${defaultMaxResults}`}>
                  <NumberInput className="w-28" min={1} suffix="条" value={maxResults} aria-label="每条查询的结果数" onChange={(v) => setMaxResults(Math.min(maxResultsLimit, Math.max(1, Math.round(v))))} />
                </Group>
                <Group label="发布时间" hint="仅返回该时间范围内发布的结果，适用于时效性强的查询">
                  <Segmented stretch size="sm" value={range} onChange={setRange} options={ranges} />
                </Group>
                <Group label="限定域名" hint="含子域名">
                  <ChipInput value={include} onChange={setInclude} max={maxDomains} normalize={domain} placeholder="docs.python.org" aria-label="限定域名" />
                </Group>
                <Group label="排除域名">
                  <ChipInput value={exclude} onChange={setExclude} max={maxDomains} normalize={domain} placeholder="pinterest.com" aria-label="排除域名" />
                </Group>
              </OptionGroup>
              <ProviderParams tool="search" engine={engine} tuning={tuning} />
            </>
          }
        >
          <textarea
            rows={3}
            value={text}
            spellCheck={false}
            aria-label="查询"
            placeholder={"每行一条查询，最多 3 条，并行执行"}
            className={cx(bare, "num resize-none pt-3.5 pb-2 text-sm leading-6")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onModEnter(submit)}
          />
          {over && (
            <div className="px-4 pb-2 text-xs text-err">
              <span className="num">{queries.length}</span> 条查询，单次上限 {maxQueries} 条
            </div>
          )}
        </Composer>
        {queries.length === 0 && <Examples items={["mcp streamable http spec", "go 1.27 release notes", "sqlite wal mode performance"]} onPick={setText} />}
      </Stage>

      {(run.isPending || run.error || data) && (
        <Output
          stamp={run.submittedAt}
          view={view}
          onView={setView}
          tabs={[
            { value: "result", label: "结果" },
            { value: "trace", label: traceLabel(data?.attempts) },
          ]}
          actions={
            view === "result" &&
            data && (
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
            data &&
            !run.isPending && (
              <>
                <span className="num text-ink">{duration(data.duration_ms)}</span>
                {engines.map((e) => (
                  <Badge key={e} tone="signal">
                    {e}
                  </Badge>
                ))}
                <span>
                  {data.results.length} 条查询 · {found} 条结果
                </span>
                {run.variables?.route && <Badge>临时参数</Badge>}
              </>
            )
          }
        >
          <TabPanel value="result">
            {run.isPending ? (
              <Waiting label={run.variables?.queries.join(" · ")} elapsed={elapsed} />
            ) : run.error ? (
              <Failure error={run.error} />
            ) : data && format === "json" ? (
              <JSONView value={data.results} />
            ) : (
              data && <SearchResults key={run.submittedAt} results={data.results} />
            )}
          </TabPanel>
          <TabPanel value="trace">
            <TraceView attempts={run.isPending ? undefined : data?.attempts} total={data?.duration_ms ?? 0} />
          </TabPanel>
        </Output>
      )}

      <Recent tool="search" stamp={run.isPending ? undefined : run.submittedAt || undefined} onPick={restore} />
    </>
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
                "inline-flex h-7 max-w-72 shrink-0 items-center gap-1.5 rounded-ctl border px-2.5 text-xs transition-colors",
                i === index ? "border-line-strong bg-raised text-ink" : "border-line text-ink-3 hover:text-ink",
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
        <Notice tone="err">
          <span className="font-medium text-ink">{result.query}</span>：{result.error}
        </Notice>
      </div>
    );
  }
  if (items.length === 0) return <Empty title="该查询没有结果">可放宽时间范围或域名过滤后重试。</Empty>;
  return (
    <ol>
      {items.map((item, i) => (
        <li key={`${item.url}-${i}`} className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0">
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
              <p className="mt-1 text-xs text-ink-3">提供商未返回摘要。</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
