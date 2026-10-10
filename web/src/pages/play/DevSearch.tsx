import { useMutation } from "@tanstack/react-query";
import { ExternalLink, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { api, type DevSearchArgs, type DevSearchItem } from "../../lib/api";
import { useConfig } from "../../lib/config";
import { duration } from "../../lib/format";
import { useElapsed } from "../../lib/motion";
import { ChipInput } from "../../ui/inputs";
import { Markdown } from "../../ui/markdown";
import { Badge, cx, Empty, NumberInput, Segmented } from "../../ui/primitives";
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
  const [view, setView] = useState<"result" | "trace">("result");
  const [format, setFormat] = useState<"visual" | "json">("visual");
  const tuning = useTuning("dev_search", engine);
  const run = useMutation({ mutationFn: api.playDevSearch });
  const elapsed = useElapsed(run.isPending);

  const args: DevSearchArgs = { query: query.trim() };
  if (maxResults !== defaultMaxResults) args.maxResults = maxResults;
  if (types.length > 0) args.types = types;
  if (repos.length > 0) args.repos = repos;

  const ready = args.query !== "";
  const submit = () => {
    if (!ready || run.isPending) return;
    setView("result");
    run.mutate({ ...args, search_engine: engine === "auto" ? undefined : engine, route: tuning.route });
  };

  const restore = (request: Record<string, unknown>) => {
    setQuery(typeof request.query === "string" ? request.query : "");
    setMaxResults(typeof request.maxResults === "number" ? request.maxResults : defaultMaxResults);
    setTypes(words(request.types).filter((t) => t in devTypeLabel));
    setRepos(words(request.repos));
  };

  const data = run.data;
  const typeSummary = types.length > 0 ? devTypes.filter((t) => types.includes(t.value)).map((t) => t.label).join("、") : "全部类型";

  return (
    <>
      <Stage title="搜索开发资料" description="调用 dev_search 工具。检索范围是公开代码仓库的 issue、已合并 PR、README 与文档站，不是开放网页。">
        <Composer
          open={open}
          tools={
            <>
              <Chip icon={<SlidersHorizontal />} label="参数" aria-pressed={open} onClick={() => setOpen(!open)} />
              <ProviderChip tool="dev_search" value={engine} onChange={setEngine} changed={tuning.changed} />
              <Summary onClick={() => setOpen(true)}>{[`${maxResults} 条`, typeSummary, repos.length > 0 && `限定 ${repos.length} 个仓库`].filter(Boolean).join(" · ")}</Summary>
            </>
          }
          actions={
            <>
              <CodeButton
                tool="dev_search"
                args={args}
                notices={<LocalNotice items={[engine !== "auto" && `固定提供商 ${provider(engine).name}`, tuning.changed && `${provider(engine).name} 的临时参数`]} />}
              />
              <RunButton label="搜索" loading={run.isPending} disabled={!ready} onClick={submit} />
            </>
          }
          panel={
            <>
              <OptionGroup title="调用参数">
                <Group label="结果数" hint={`1–${devMaxResults}，默认 ${defaultMaxResults}。每条结果附带匹配段落，篇幅远大于普通搜索的摘要`}>
                  <NumberInput className="w-28" min={1} suffix="条" value={maxResults} aria-label="结果数" onChange={(v) => setMaxResults(Math.min(devMaxResults, Math.max(1, Math.round(v))))} />
                </Group>
                <Group label="结果类型" hint="不选即全部">
                  <div className="flex flex-wrap gap-2">
                    {devTypes.map((type) => {
                      const on = types.includes(type.value);
                      return (
                        <button
                          key={type.value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setTypes(on ? types.filter((t) => t !== type.value) : [...types, type.value])}
                          className={cx(
                            "flex h-7 items-center rounded-ctl border px-2.5 text-xs transition-colors",
                            on ? "border-signal-text bg-signal/12 text-ink" : "border-line text-ink-3 hover:border-line-strong",
                          )}
                        >
                          {type.label}
                        </button>
                      );
                    })}
                  </div>
                </Group>
                <Group label="限定仓库" hint="只检索这些仓库的 issue、PR 与 README；对文档类结果无效">
                  <ChipInput value={repos} onChange={setRepos} max={devMaxRepos} normalize={repo} placeholder="modelcontextprotocol/go-sdk" aria-label="限定仓库" />
                </Group>
              </OptionGroup>
              <ProviderParams tool="dev_search" engine={engine} tuning={tuning} />
            </>
          }
        >
          <textarea
            rows={3}
            value={query}
            spellCheck={false}
            aria-label="问题"
            placeholder="用自然语言提问，并写明库或框架的名称"
            className={cx(bare, "resize-none pt-3.5 pb-2 leading-6")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onModEnter(submit)}
          />
        </Composer>
        {args.query === "" && (
          <Examples items={["go-sdk streamable http stateless mode behind a reverse proxy", "sqlite busy_timeout with WAL mode", "vite proxy websocket not forwarded"]} onPick={setQuery} />
        )}
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
                {data.result.search_engine && <Badge tone="signal">{data.result.search_engine}</Badge>}
                <span>{data.result.results.length} 条结果</span>
                {run.variables?.route && <Badge>临时参数</Badge>}
              </>
            )
          }
        >
          <TabPanel value="result">
            {run.isPending ? (
              <Waiting label={run.variables?.query} elapsed={elapsed} />
            ) : run.error ? (
              <Failure error={run.error} />
            ) : data?.result.error ? (
              <Failure error={new Error(data.result.error)} />
            ) : data && format === "json" ? (
              <JSONView value={data.result} />
            ) : (
              data && <DevResults key={run.submittedAt} items={data.result.results} />
            )}
          </TabPanel>
          <TabPanel value="trace">
            <TraceView attempts={run.isPending ? undefined : data?.attempts} total={data?.duration_ms ?? 0} />
          </TabPanel>
        </Output>
      )}

      <Recent tool="dev_search" stamp={run.isPending ? undefined : run.submittedAt || undefined} onPick={restore} />
    </>
  );
}

function DevResults({ items }: { items: DevSearchItem[] }) {
  if (items.length === 0) return <Empty title="没有结果">可放宽类型或仓库限定后重试。</Empty>;
  return (
    <ol>
      {items.map((item, i) => (
        <li key={`${item.url}-${i}`} className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0">
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
              <div key={n} className="mt-2 max-h-72 overflow-y-auto rounded-ctl border border-line bg-sunken px-3 py-2 text-xs">
                <Markdown>{passage}</Markdown>
              </div>
            )) ?? <p className="mt-1 text-xs text-ink-3">提供商未返回匹配段落。</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
