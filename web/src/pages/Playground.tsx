import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Play } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { allModels, hasOtherModels, ModelOverride } from "../components/ModelPicker";
import { ProviderPicker } from "../components/ProviderPicker";
import { Waterfall } from "../components/Waterfall";
import { api, type Attempt, type DevSearchArgs, type DevSearchItem, type FetchArgs, type FetchResult, type ResearchStep, type SearchArgs, type SearchResult } from "../lib/api";
import { useConfig } from "../lib/config";
import { compact, duration } from "../lib/format";
import { PageHeader } from "../Shell";
import { ChipInput } from "../ui/inputs";
import { Markdown } from "../ui/markdown";
import { Badge, Button, CodeBlock, cx, Dot, Empty, Notice, NumberInput, Section, Segmented, Spinner, TabList, TabPanel, Tabs } from "../ui/primitives";

type Tool = "search" | "dev_search" | "fetch" | "research";
type View = "result" | "detail" | "code";

// The limits of the search tool (search.MaxQueries, search.MaxDomains, maxResults).
const maxQueries = 3;
const maxDomains = 10;
const maxResultsLimit = 100;
const defaultMaxResults = 5;
// The limits of the dev_search tool (search.DevMaxResults, search.DevMaxRepos).
const devMaxResults = 20;
const devMaxRepos = 10;

const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

export function PlaygroundPage() {
  const [tool, setTool] = useState<Tool>("search");
  const switcher = (
    <Segmented
      stretch
      value={tool}
      onChange={setTool}
      options={[
        { value: "search", label: "搜索" },
        { value: "dev_search", label: "开发者" },
        { value: "fetch", label: "抓取" },
        { value: "research", label: "研究" },
      ]}
    />
  );
  // Every tool stays mounted, so switching keeps its form, its result and a running research task.
  return (
    <>
      <PageHeader title="调试台" description="直接调用网关工具，路由、限流与故障转移均与 MCP 调用一致，调用记入请求日志。" />
      <div hidden={tool !== "search"}>
        <SearchPlay switcher={switcher} />
      </div>
      <div hidden={tool !== "dev_search"}>
        <DevSearchPlay switcher={switcher} />
      </div>
      <div hidden={tool !== "fetch"}>
        <FetchPlay switcher={switcher} />
      </div>
      <div hidden={tool !== "research"}>
        <ResearchPlay switcher={switcher} />
      </div>
    </>
  );
}

/* ---------- Frame ---------- */

function Workbench({ switcher, composer, output }: { switcher: ReactNode; composer: ReactNode; output: ReactNode }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[26rem_minmax(0,1fr)]">
      <section className="rounded-panel border border-line bg-surface lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
        <div className="border-b border-line p-3">{switcher}</div>
        {composer}
      </section>
      {/* No overflow clipping here: it would stop the paging footer from sticking to the viewport. */}
      <section className="flex min-h-[calc(100vh-8.5rem)] min-w-0 flex-col rounded-panel border border-line bg-surface">{output}</section>
    </div>
  );
}

const bare = "block w-full bg-transparent px-3 text-sm text-ink placeholder:text-ink-3 focus:outline-none";

/** The main input of a tool, with the run button inside it. */
function Composer({ children, meta, action }: { children: ReactNode; meta?: ReactNode; action: ReactNode }) {
  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-ctl border border-line bg-sunken transition-colors focus-within:border-signal-text">
        {children}
        <div className="flex items-center gap-3 px-2.5 pt-1 pb-2.5">
          <div className="min-w-0 flex-1 text-xs text-ink-3">{meta}</div>
          {action}
        </div>
      </div>
    </div>
  );
}

function RunButton({ label, loading, disabled, onClick }: { label: string; loading: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <Button variant="primary" icon={<Play />} loading={loading} disabled={disabled} onClick={onClick}>
      {label}
      <kbd className="num text-2xs opacity-60">{mod}↵</kbd>
    </Button>
  );
}

const onModEnter = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    run();
  }
};

/** A labelled control that is not a single form field, so it must not sit in a <label>. */
function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </div>
  );
}

/** The result pane: the result, a second view (the upstream calls or the steps) and the call as code. */
function Output({
  view,
  onView,
  detail,
  actions,
  strip,
  result,
  code,
}: {
  view: View;
  onView: (view: View) => void;
  detail: { label: ReactNode; content: ReactNode };
  actions?: ReactNode;
  strip?: ReactNode;
  result: ReactNode;
  code: ReactNode;
}) {
  return (
    <Tabs value={view} onChange={onView} className="flex-1">
      <TabList
        tabs={[
          { value: "result", label: "结果" },
          { value: "detail", label: detail.label },
          { value: "code", label: "代码" },
        ]}
        actions={view === "result" && actions}
      />
      {strip && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 text-xs text-ink-3">{strip}</div>}
      <TabPanel value="result" className="flex flex-col">
        {result}
      </TabPanel>
      <TabPanel value="detail" className="p-4">
        {detail.content}
      </TabPanel>
      <TabPanel value="code" className="p-4">
        {code}
      </TabPanel>
    </Tabs>
  );
}

function useElapsed(running: boolean): number {
  const [span, setSpan] = useState({ start: 0, now: 0 });
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setSpan({ start, now: start });
    const timer = setInterval(() => setSpan({ start, now: Date.now() }), 100);
    return () => clearInterval(timer);
  }, [running]);
  return span.now - span.start;
}

function Waiting({ label, elapsed }: { label: ReactNode; elapsed: number }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm text-ink-2">
      <Spinner />
      <span className="max-w-md truncate text-center">{label}</span>
      <span className="num text-xs text-ink-3">{duration(elapsed)}</span>
    </div>
  );
}

function Start({ title, examples, mono = true, onPick }: { title: string; examples: string[]; mono?: boolean; onPick: (example: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-12 text-center">
      <Play className="size-5 text-ink-3" />
      <div className="text-sm text-ink-2">{title}</div>
      <div className="text-xs text-ink-3">或从示例开始：</div>
      <div className="flex max-w-xl flex-wrap justify-center gap-2">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPick(example)}
            className={cx("max-w-full truncate rounded-ctl border border-line px-2.5 py-1 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink", mono && "num")}
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

function Failure({ error }: { error: Error }) {
  return (
    <div className="p-4">
      <Notice tone="err">{error.message}</Notice>
    </div>
  );
}

/* ---------- Upstream calls and code ---------- */

const count = (attempts: Attempt[], ...statuses: Attempt["status"][]) => attempts.filter((a) => statuses.includes(a.status)).length;
/** Attempts that did not serve the call. A canceled attempt lost a race, which is normal. */
const failures = (attempts: Attempt[]) => count(attempts, "error", "skipped", "limited");

function traceLabel(attempts: Attempt[] | null | undefined): ReactNode {
  return (
    <>
      调用链
      {attempts && attempts.length > 0 && <span className="num text-xs text-ink-3">{attempts.length}</span>}
      {attempts && failures(attempts) > 0 && <Dot tone="warn" />}
    </>
  );
}

function TraceView({ attempts, total }: { attempts: Attempt[] | null | undefined; total: number }) {
  if (attempts === undefined) return <Empty title="运行后，此处按时间轴显示本次调用的上游请求" />;
  if (!attempts || attempts.length === 0) return <div className="text-xs text-ink-3">本次调用未请求任何上游提供商。</div>;
  // A provider that was passed over, or a cache hit, is a note and not a call.
  const failed = count(attempts, "error");
  const skipped = count(attempts, "skipped", "limited");
  const cached = count(attempts, "cached");
  const calls = attempts.length - skipped - cached;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-3">
        上游调用 {calls} 次{failed > 0 && `，失败 ${failed} 次`}
        {skipped > 0 && `；因熔断或限流跳过 ${skipped} 次`}
        {cached > 0 && `；缓存命中 ${cached} 次`}。完整记录见{" "}
        <Link href="/logs" className="text-ink-2 underline underline-offset-2 hover:text-ink">
          请求日志
        </Link>
        。
      </p>
      <Waterfall attempts={attempts} total={total} />
    </div>
  );
}

function CodeView({ tool, args, notice }: { tool: string; args: object; notice?: ReactNode }) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, null, 2);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-3">
        MCP 客户端调用 <span className="num text-ink-2">{tool}</span> 工具时发送的请求，随左侧设置实时更新；未列出的参数取默认值。
      </p>
      {notice}
      <CodeBlock copy>{body}</CodeBlock>
    </div>
  );
}

function ModelNotice({ model }: { model: string | undefined }) {
  return model ? (
    <Notice tone="info">
      所选模型 <span className="num text-ink">{model}</span> 仅在调试台生效。MCP 调用不支持指定模型，Agent 始终使用配置中的模型。
    </Notice>
  ) : null;
}

function JSONView({ value }: { value: unknown }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-xs text-ink-3">MCP 工具返回给 Agent 的原始内容。</p>
      <CodeBlock copy wrap>
        {JSON.stringify(value, null, 2)}
      </CodeBlock>
    </div>
  );
}

/* ---------- Search ---------- */

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

function SearchPlay({ switcher }: { switcher: ReactNode }) {
  const { provider } = useConfig();
  const [text, setText] = useState("");
  const [maxResults, setMaxResults] = useState(defaultMaxResults);
  const [range, setRange] = useState("");
  const [engine, setEngine] = useState("auto");
  const [include, setInclude] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [view, setView] = useState<View>("result");
  const [format, setFormat] = useState<"visual" | "json">("visual");
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
    if (view === "code") setView("result");
    run.mutate(args);
  };

  const data = run.data;
  const found = data?.results.reduce((n, r) => n + (r.web?.length ?? 0) + (r.videos?.length ?? 0), 0) ?? 0;
  const engines = [...new Set(data?.results.map((r) => r.search_engine).filter(Boolean))];
  const filters = [include.length > 0 && `限定 ${include.length} 个`, exclude.length > 0 && `排除 ${exclude.length} 个`].filter(Boolean).join(" · ");

  return (
    <Workbench
      switcher={switcher}
      composer={
        <>
          <Composer
            meta={
              over ? (
                <span className="text-err">
                  <span className="num">{queries.length}</span> 条查询，单次上限 {maxQueries} 条
                </span>
              ) : (
                <>
                  <span className="num">
                    {queries.length}/{maxQueries}
                  </span>{" "}
                  条查询，每行一条，并行执行
                </>
              )
            }
            action={<RunButton label="搜索" loading={run.isPending} disabled={!ready} onClick={submit} />}
          >
            <textarea
              rows={4}
              value={text}
              spellCheck={false}
              aria-label="查询"
              placeholder={"go 1.27 release notes\nmcp streamable http spec"}
              className={cx(bare, "resize-none pt-2.5 leading-5")}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onModEnter(submit)}
            />
          </Composer>
          <Section title="提供商" summary={engine === "auto" ? "自动" : provider(engine).name} defaultOpen>
            <ProviderPicker tool="search" value={engine} onChange={setEngine} />
          </Section>
          <Section title="数量与时间" summary={`每条查询 ${maxResults} 条 · ${range ? `近${ranges.find((r) => r.value === range)?.label}` : "时间不限"}`}>
            <Group label="每条查询的结果数" hint={`1–${maxResultsLimit}，默认 ${defaultMaxResults}`}>
              <NumberInput min={1} value={maxResults} aria-label="每条查询的结果数" onChange={(v) => setMaxResults(Math.min(maxResultsLimit, Math.max(1, Math.round(v))))} />
            </Group>
            <Group label="发布时间" hint="仅返回该时间范围内发布的结果，适用于时效性强的查询">
              <Segmented stretch size="sm" value={range} onChange={setRange} options={ranges} />
            </Group>
          </Section>
          <Section title="域名过滤" summary={filters || "不限"}>
            <Group label="限定域名" hint="含子域名">
              <ChipInput value={include} onChange={setInclude} max={maxDomains} normalize={domain} placeholder="docs.python.org" aria-label="限定域名" />
            </Group>
            <Group label="排除域名">
              <ChipInput value={exclude} onChange={setExclude} max={maxDomains} normalize={domain} placeholder="pinterest.com" aria-label="排除域名" />
            </Group>
          </Section>
        </>
      }
      output={
        <Output
          view={view}
          onView={setView}
          detail={{ label: traceLabel(data?.attempts), content: <TraceView attempts={data?.attempts} total={data?.duration_ms ?? 0} /> }}
          actions={
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
              </>
            )
          }
          result={
            run.isPending ? (
              <Waiting label={queries.join(" · ")} elapsed={elapsed} />
            ) : run.error ? (
              <Failure error={run.error} />
            ) : data ? (
              format === "json" ? (
                <JSONView value={data.results} />
              ) : (
                <SearchResults key={run.submittedAt} results={data.results} />
              )
            ) : (
              <Start title="输入查询后，此处显示各提供商返回的结果" examples={["mcp streamable http spec", "go 1.27 release notes", "sqlite wal mode performance"]} onPick={setText} />
            )
          }
          code={
            <CodeView
              tool="search"
              args={args}
              notice={
                over && (
                  <Notice tone="warn">
                    已输入 {queries.length} 条查询，单次调用最多执行 {maxQueries} 条。Agent 以相同参数调用时，超出部分将被忽略，因此此处仅列出实际执行的前 {maxQueries} 条。
                  </Notice>
                )
              }
            />
          }
        />
      }
    />
  );
}

/** Brave words the age of a result; Exa gives a timestamp, of which the date is enough. */
const age = (text: string) => (/^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text);

function host(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

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

/* ---------- Developer search ---------- */

const devTypes = [
  { value: "doc", label: "文档" },
  { value: "issue", label: "Issue" },
  { value: "pull_request", label: "PR" },
  { value: "readme", label: "README" },
];

const repo = (text: string) =>
  text
    .replace(/^.*github\.com\//, "")
    .replace(/\.git$/, "")
    .split("/")
    .slice(0, 2)
    .join("/");

function DevSearchPlay({ switcher }: { switcher: ReactNode }) {
  const { config, provider } = useConfig();
  const [query, setQuery] = useState("");
  const [maxResults, setMaxResults] = useState(defaultMaxResults);
  const [types, setTypes] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [view, setView] = useState<View>("result");
  const [format, setFormat] = useState<"visual" | "json">("visual");
  const run = useMutation({ mutationFn: api.playDevSearch });
  const elapsed = useElapsed(run.isPending);

  const args: DevSearchArgs = { query: query.trim() };
  if (maxResults !== defaultMaxResults) args.maxResults = maxResults;
  if (types.length > 0) args.types = types;
  if (repos.length > 0) args.repos = repos;

  const ready = args.query !== "";
  const submit = () => {
    if (!ready || run.isPending) return;
    if (view === "code") setView("result");
    run.mutate(args);
  };

  const data = run.data;
  const routes = config.dev_search.routes.filter((r) => r.enabled);

  return (
    <Workbench
      switcher={switcher}
      composer={
        <>
          <Composer meta="用自然语言提问，并写明库或框架的名称" action={<RunButton label="搜索" loading={run.isPending} disabled={!ready} onClick={submit} />}>
            <textarea
              rows={4}
              value={query}
              spellCheck={false}
              aria-label="问题"
              placeholder="how do I configure retries in the go-sdk streamable http client"
              className={cx(bare, "resize-none pt-2.5 leading-5")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onModEnter(submit)}
            />
          </Composer>
          <Section title="提供商" summary={routes.map((r) => provider(r.provider).name).join(" · ") || "未启用"} defaultOpen>
            <p className="text-xs text-ink-3">
              按{" "}
              <Link href="/search" className="text-ink-2 underline underline-offset-2 hover:text-ink">
                搜索页
              </Link>{" "}
              的开发者搜索路由执行。检索范围是公开代码仓库的 issue、已合并 PR、README 与文档站，不是开放网页。
            </p>
          </Section>
          <Section title="数量与类型" summary={`${maxResults} 条 · ${types.length > 0 ? devTypes.filter((t) => types.includes(t.value)).map((t) => t.label).join("、") : "全部类型"}`}>
            <Group label="结果数" hint={`1–${devMaxResults}，默认 ${defaultMaxResults}。每条结果附带匹配段落，篇幅远大于普通搜索的摘要`}>
              <NumberInput min={1} value={maxResults} aria-label="结果数" onChange={(v) => setMaxResults(Math.min(devMaxResults, Math.max(1, Math.round(v))))} />
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
          </Section>
          <Section title="仓库" summary={repos.length > 0 ? `限定 ${repos.length} 个` : "不限"}>
            <Group label="限定仓库" hint="只检索这些仓库的 issue、PR 与 README；对文档类结果无效">
              <ChipInput value={repos} onChange={setRepos} max={devMaxRepos} normalize={repo} placeholder="modelcontextprotocol/go-sdk" aria-label="限定仓库" />
            </Group>
          </Section>
        </>
      }
      output={
        <Output
          view={view}
          onView={setView}
          detail={{ label: traceLabel(data?.attempts), content: <TraceView attempts={data?.attempts} total={data?.duration_ms ?? 0} /> }}
          actions={
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
              </>
            )
          }
          result={
            run.isPending ? (
              <Waiting label={args.query} elapsed={elapsed} />
            ) : run.error ? (
              <Failure error={run.error} />
            ) : data?.result.error ? (
              <Failure error={new Error(data.result.error)} />
            ) : data ? (
              format === "json" ? (
                <JSONView value={data.result} />
              ) : (
                <DevResults key={run.submittedAt} items={data.result.results} />
              )
            ) : (
              <Start
                title="输入问题后，此处显示命中的 issue、PR、README 与文档段落"
                examples={["go-sdk streamable http stateless mode behind a reverse proxy", "sqlite busy_timeout with WAL mode", "vite proxy websocket not forwarded"]}
                onPick={setQuery}
              />
            )
          }
          code={<CodeView tool="dev_search" args={args} />}
        />
      }
    />
  );
}

const devTypeLabel: Record<string, string> = Object.fromEntries(devTypes.map((t) => [t.value, t.label]));

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

/* ---------- Fetch ---------- */

function FetchPlay({ switcher }: { switcher: ReactNode }) {
  const { config, provider } = useConfig();
  const chain = config.fetch.extract.models;
  const models = allModels(config);
  // Without an extract chain a model can still be tried, picked here.
  const canExtract = chain.length > 0 || models.length > 0;
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState(chain.length > 0);
  const [model, setModel] = useState("");
  const [offset, setOffset] = useState(0);
  const [engine, setEngine] = useState("auto");
  const [view, setView] = useState<View>("result");
  const [format, setFormat] = useState<"rendered" | "text" | "json">("rendered");
  const run = useMutation({ mutationFn: api.playFetch });
  const elapsed = useElapsed(run.isPending);

  const extract = answer && canExtract;
  const args: FetchArgs = { url: url.trim(), prompt: extract ? prompt.trim() : "" };
  if (!extract) args.raw = true;
  if (!extract && offset > 0) args.offset = offset;
  if (engine !== "auto") args.fetch_engine = engine;

  const override = extract && model ? model : undefined;

  const ready = args.url !== "" && (!extract || args.prompt !== "");
  const send = (next: FetchArgs) => {
    if (view === "code") setView("result");
    run.mutate({ ...next, model: next.raw ? undefined : override });
  };
  // An offset belongs to one page.
  const changeUrl = (next: string) => {
    setUrl(next);
    setOffset(0);
  };
  const chooseAnswer = (on: boolean) => {
    setAnswer(on);
    if (on && chain.length === 0 && !model) setModel(models[0]?.id ?? "");
  };
  const submit = () => ready && !run.isPending && send(args);

  const data = run.data;
  const cached = data?.attempts?.some((a) => a.status === "cached");

  return (
    <Workbench
      switcher={switcher}
      composer={
        <>
          <Composer
            meta={extract ? (override ? <span className="num block truncate">由 {override} 作答</span> : "由提取模型按问题作答") : "返回页面原文"}
            action={<RunButton label="抓取" loading={run.isPending} disabled={!ready} onClick={submit} />}
          >
            <input
              value={url}
              spellCheck={false}
              autoComplete="off"
              aria-label="URL"
              placeholder="https://"
              className={cx(bare, "num h-10")}
              onChange={(e) => changeUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {extract && (
              <textarea
                rows={3}
                value={prompt}
                aria-label="针对页面的问题"
                placeholder="这个版本有哪些破坏性变更？"
                className={cx(bare, "resize-none border-t border-line pt-2.5 leading-5")}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onModEnter(submit)}
              />
            )}
          </Composer>
          <Section title="返回内容" summary={extract ? "提取回答" : offset > 0 ? `原文 · 从 ${compact(offset)} 字节起` : "原文"} defaultOpen>
            {canExtract ? (
              <Segmented
                stretch
                size="sm"
                value={extract ? "answer" : "raw"}
                onChange={(v) => chooseAnswer(v === "answer")}
                options={[
                  { value: "answer", label: "提取回答" },
                  { value: "raw", label: "原文" },
                ]}
              />
            ) : (
              <Notice tone="warn">
                尚未配置模型，仅可返回原文。请前往{" "}
                <Link href="/models" className="text-ink underline underline-offset-2">
                  模型接口
                </Link>{" "}
                页添加。
              </Notice>
            )}
            {canExtract && chain.length === 0 && (
              <p className="-mt-2 text-xs text-ink-3">抓取工具尚未指派提取模型，Agent 仅能获得原文。可在此选择一个模型试用。</p>
            )}
            <p className="-mt-2 text-xs text-ink-3">
              {extract ? "提取模型读取整页内容，仅返回与问题相关的部分，这是 Agent 的默认调用方式。" : "返回页面的 Markdown 原文，较长的页面分段返回。"}
            </p>
            {!extract && (
              <Group label="起始位置" hint="读取的起始偏移量，单位为字节；续读长页面时填入上一段返回的位置">
                <NumberInput min={0} suffix="字节" value={offset} aria-label="起始位置" onChange={(v) => setOffset(Math.round(v))} />
              </Group>
            )}
          </Section>
          {extract && hasOtherModels(config, chain) && (
            <Section title="提取模型" summary={override ?? chain.join(" → ")}>
              <ModelOverride assigned={chain} value={model} onChange={setModel} />
              <p className="text-xs text-ink-3">仅对本次调试生效，不修改配置。所选模型单独作答，失败时不切换备用模型。</p>
            </Section>
          )}
          <Section title="提供商" summary={engine === "auto" ? "自动" : provider(engine).name}>
            <ProviderPicker tool="fetch" value={engine} onChange={setEngine} />
          </Section>
        </>
      }
      output={
        <Output
          view={view}
          onView={setView}
          detail={{ label: traceLabel(data?.attempts), content: <TraceView attempts={data?.attempts} total={data?.duration_ms ?? 0} /> }}
          actions={
            data && (
              <Segmented
                size="sm"
                value={format}
                onChange={setFormat}
                options={[
                  { value: "rendered", label: "渲染" },
                  { value: "text", label: "文本" },
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
                {data.result.fetch_engine && <Badge tone="signal">{data.result.fetch_engine}</Badge>}
                {cached && <Badge tone="info">缓存命中</Badge>}
                {run.variables?.model && <Badge>{run.variables.model}</Badge>}
                <span>{data.result.answer !== undefined ? "提取回答" : "原文"}</span>
                {data.result.content_length !== undefined && <span className="num">全文 {compact(data.result.content_length)} 字节</span>}
              </>
            )
          }
          result={
            run.isPending ? (
              <Waiting label={run.variables?.url} elapsed={elapsed} />
            ) : run.error ? (
              <Failure error={run.error} />
            ) : data ? (
              format === "json" ? (
                <JSONView value={data.result} />
              ) : (
                <FetchResultView
                  result={data.result}
                  from={run.variables?.offset ?? 0}
                  rendered={format === "rendered"}
                  onNext={(next) => {
                    // Reads on from the page that was fetched, whatever the form says by now.
                    const ran = run.variables;
                    if (!ran) return;
                    setUrl(ran.url);
                    setEngine(ran.fetch_engine ?? "auto");
                    setAnswer(false);
                    setOffset(next);
                    const more: FetchArgs = { url: ran.url, prompt: "", raw: true, offset: next };
                    if (ran.fetch_engine) more.fetch_engine = ran.fetch_engine;
                    send(more);
                  }}
                />
              )
            ) : (
              <Start
                title="输入 URL 后，此处显示抓取到的内容"
                examples={["https://modelcontextprotocol.io/specification/draft/basic/transports", "https://go.dev/doc/devel/release"]}
                onPick={changeUrl}
              />
            )
          }
          code={<CodeView tool="fetch" args={args} notice={<ModelNotice model={override} />} />}
        />
      }
    />
  );
}

function FetchResultView({ result, from, rendered, onNext }: { result: FetchResult; from: number; rendered: boolean; onNext: (offset: number) => void }) {
  const body = result.answer ?? result.content ?? "";
  const total = result.content_length ?? 0;
  const [start, end] = result.covered ?? [from, result.next_offset || total];
  const more = result.next_offset !== undefined && result.next_offset > 0;
  return (
    <>
      {(result.error || result.warning || result.answer_truncated) && (
        <div className="flex flex-col gap-2 px-4 pt-4">
          {result.error && <Notice tone="err">{result.error}</Notice>}
          {result.warning && <Notice tone="warn">{result.warning}</Notice>}
          {result.answer_truncated && <Notice tone="warn">模型未在超时前完成输出，以下为已接收的部分。</Notice>}
        </div>
      )}
      {(result.title || body) && (
        <article className="flex-1 px-5 py-4">
          {(result.title || result.description) && (
            <header className="mb-4 border-b border-line pb-3">
              <h2 className="text-lg font-medium">{result.title || "（无标题）"}</h2>
              {result.description && <p className="mt-1 text-xs text-ink-3">{result.description}</p>}
            </header>
          )}
          {rendered ? (
            <Markdown>{body}</Markdown>
          ) : (
            <CodeBlock copy wrap>
              {body}
            </CodeBlock>
          )}
        </article>
      )}
      {!result.error && total > 0 && (start > 0 || end < total) && (
        <footer className="sticky bottom-0 flex items-center gap-4 rounded-b-panel border-t border-line bg-surface px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="relative h-1.5 rounded-full bg-sunken">
              <span className="absolute inset-y-0 rounded-full bg-signal-text" style={{ left: `${(start / total) * 100}%`, width: `${Math.max(0.5, ((end - start) / total) * 100)}%` }} />
            </div>
            <div className="num mt-1.5 text-xs text-ink-3">
              {result.answer !== undefined ? "回答依据" : "本段"} {compact(start)}–{compact(end)} / 共 {compact(total)} 字节
            </div>
          </div>
          {more && <Button onClick={() => onNext(result.next_offset!)}>继续读取</Button>}
        </footer>
      )}
    </>
  );
}

/* ---------- Research ---------- */

function ResearchPlay({ switcher }: { switcher: ReactNode }) {
  const { config } = useConfig();
  const assigned = config.research.model ? [config.research.model] : [];
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [view, setView] = useState<View>("result");
  const [format, setFormat] = useState<"rendered" | "text">("rendered");
  const start = useMutation({
    mutationFn: api.startResearch,
    onSuccess: (data) => setTaskId(data.task_id),
  });
  const task = useQuery({
    queryKey: ["research-task", taskId],
    queryFn: () => api.researchTask(taskId!),
    enabled: taskId !== null,
    refetchInterval: (query) => (query.state.data?.status === "running" || !query.state.data ? 1500 : false),
  });
  const data = task.data;
  const running = start.isPending || (taskId !== null && (!data || data.status === "running"));
  const elapsed = useElapsed(running);
  const steps = data?.steps ?? [];
  const stats = data?.stats;

  const ready = question.trim() !== "" && config.research.enabled;
  const submit = () => {
    if (!ready || running) return;
    if (view === "code") setView("result");
    start.mutate({ question: question.trim(), model: model || undefined });
  };
  const error = start.error ?? task.error;

  return (
    <Workbench
      switcher={switcher}
      composer={
        <>
          <Composer
            meta={
              <span className="num">
                {config.research.max_steps} 步 · {config.research.max_duration_seconds} 秒 · {compact(config.research.max_tokens)} token
              </span>
            }
            action={<RunButton label="开始研究" loading={running} disabled={!ready} onClick={submit} />}
          >
            <textarea
              rows={6}
              value={question}
              aria-label="研究问题"
              disabled={!config.research.enabled}
              placeholder="对比 2026 年主流网页抓取 API 的定价与限流策略"
              className={cx(bare, "resize-none pt-2.5 leading-5")}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onModEnter(submit)}
            />
          </Composer>
          {!config.research.enabled && (
            <div className="px-4 pb-4">
              <Notice tone="warn">
                深度研究尚未启用。请前往{" "}
                <Link href="/research" className="text-ink underline underline-offset-2">
                  深度研究
                </Link>{" "}
                页选择模型并启用。
              </Notice>
            </div>
          )}
          {config.research.enabled && hasOtherModels(config, assigned) && (
            <Section title="模型" summary={model || config.research.model}>
              <ModelOverride assigned={assigned} value={model} onChange={setModel} />
              <p className="text-xs text-ink-3">仅对本次研究生效，不修改配置。预算与阅读方式仍以深度研究页的设置为准。</p>
            </Section>
          )}
          <Section title="预算" summary={`${config.research.max_steps} 步 · ${config.research.max_duration_seconds} 秒`}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs">
              <dt className="text-ink-3">步数上限</dt>
              <dd className="num">{config.research.max_steps}</dd>
              <dt className="text-ink-3">时长上限</dt>
              <dd className="num">{config.research.max_duration_seconds} 秒</dd>
              <dt className="text-ink-3">Token 上限</dt>
              <dd className="num">{compact(config.research.max_tokens)}</dd>
            </dl>
            <Link href="/research" className="text-xs text-ink-3 underline underline-offset-2 hover:text-ink">
              在深度研究页修改
            </Link>
          </Section>
        </>
      }
      output={
        <Output
          view={view}
          onView={setView}
          detail={{
            label: (
              <>
                过程{steps.length > 0 && <span className="num text-xs text-ink-3">{steps.length}</span>}
              </>
            ),
            content: <StepsView steps={steps} live={running} />,
          }}
          actions={
            data?.result && (
              <Segmented
                size="sm"
                value={format}
                onChange={setFormat}
                options={[
                  { value: "rendered", label: "渲染" },
                  { value: "text", label: "文本" },
                ]}
              />
            )
          }
          strip={
            data && (
              <>
                <Badge tone={data.status === "done" ? "ok" : data.status === "failed" ? "err" : "signal"} dot>
                  {data.status === "done" ? "完成" : data.status === "failed" ? "失败" : "研究中"}
                </Badge>
                <span className="num text-ink">{duration(data.status === "running" ? Math.max(elapsed, data.updated_at - data.created_at) : data.updated_at - data.created_at)}</span>
                {stats && (
                  <span className="num">
                    {stats.steps} 步 · {stats.searches} 次搜索 · {stats.fetches} 次读取 · {compact(stats.input_tokens + stats.output_tokens)} token
                  </span>
                )}
                <Badge>{start.variables?.model ?? config.research.model}</Badge>
                <span className="num truncate">{data.id}</span>
              </>
            )
          }
          result={
            error ? (
              <Failure error={error} />
            ) : running ? (
              <Waiting label={data?.progress || "正在规划…"} elapsed={data ? Math.max(elapsed, data.updated_at - data.created_at) : elapsed} />
            ) : data ? (
              <>
                {data.error && (
                  <div className="p-4 pb-0">
                    <Notice tone="err">{data.error}</Notice>
                  </div>
                )}
                {stats?.budget_exhausted && (
                  <div className="p-4 pb-0">
                    <Notice tone="warn">预算已耗尽，Agent 已停止检索并基于现有材料撰写报告。</Notice>
                  </div>
                )}
                {data.result && (
                  <article className="px-5 py-4">
                    {format === "rendered" ? (
                      <Markdown>{data.result}</Markdown>
                    ) : (
                      <CodeBlock copy wrap>
                        {data.result}
                      </CodeBlock>
                    )}
                  </article>
                )}
              </>
            ) : (
              <Start
                title="输入需要多方查证的问题后，研究报告显示在此处"
                examples={["对比 Brave、Exa、Tavily 搜索 API 的定价与限流", "SQLite WAL 模式在高并发写入下的取舍"]}
                mono={false}
                onPick={setQuestion}
              />
            )
          }
          code={<CodeView tool="research" args={{ question: question.trim() }} notice={<ModelNotice model={model || undefined} />} />}
        />
      }
    />
  );
}

function StepsView({ steps, live }: { steps: ResearchStep[]; live: boolean }) {
  if (steps.length === 0) return <Empty title={live ? "等待第一个步骤…" : "开始研究后，此处按顺序列出 Agent 的各个步骤"} />;
  return (
    <ol className="flex flex-col">
      {steps.map((step, i) => {
        const current = live && i === steps.length - 1;
        return (
          <li key={i} className="flex gap-3 border-b border-line py-2 last:border-b-0">
            <span className="num w-14 shrink-0 text-right text-xs text-ink-3">{duration(step.at)}</span>
            <Dot tone={current ? "signal" : "neutral"} live={current} className="mt-1.5" />
            <span className={cx("num min-w-0 flex-1 text-xs break-words", current ? "text-ink" : "text-ink-2")}>{step.line}</span>
          </li>
        );
      })}
    </ol>
  );
}
