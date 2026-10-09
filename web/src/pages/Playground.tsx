import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Play } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { api, type FetchResult, type SearchResult } from "../lib/api";
import { useConfig } from "../lib/config";
import { compact, duration } from "../lib/format";
import { PageHeader } from "../Shell";
import { Badge, Button, CodeBlock, Empty, Field, Input, Notice, NumberInput, Panel, Segmented, Select, Spinner, Switch, Textarea } from "../ui/primitives";

type Tab = "search" | "fetch" | "research";

export function PlaygroundPage() {
  const [tab, setTab] = useState<Tab>("search");
  return (
    <>
      <PageHeader
        title="调试台"
        description="不经过 Agent，直接调用网关的工具。走的是和 MCP 完全相同的路由、限流和故障转移，结果会记入日志。"
        actions={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "search", label: "搜索" },
              { value: "fetch", label: "抓取" },
              { value: "research", label: "研究" },
            ]}
          />
        }
      />
      {tab === "search" && <SearchPlay />}
      {tab === "fetch" && <FetchPlay />}
      {tab === "research" && <ResearchPlay />}
    </>
  );
}

function Layout({ form, children }: { form: ReactNode; children: ReactNode }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <Panel className="lg:sticky lg:top-4">{form}</Panel>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function EngineSelect({ tool, value, onChange }: { tool: "search" | "fetch"; value: string; onChange: (value: string) => void }) {
  const { config, provider } = useConfig();
  const routes = (tool === "search" ? config.search.routes : config.fetch.routes).filter((r) => r.enabled);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="auto">自动（按路由优先级）</option>
      {routes.map((r) => (
        <option key={r.provider} value={r.provider}>
          仅 {provider(r.provider).name}
        </option>
      ))}
    </Select>
  );
}

function ResultMeta({ ms, children }: { ms: number; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">
      <span className="num text-ink">{duration(ms)}</span>
      {children}
      <Link href="/logs" className="ml-auto underline underline-offset-2 hover:text-ink">
        在日志中查看调用链
      </Link>
    </div>
  );
}

function Failure({ error }: { error: Error | null }) {
  return error ? <Notice tone="err">{error.message}</Notice> : null;
}

function Idle({ pending, children }: { pending: boolean; children: string }) {
  return (
    <Panel>
      {pending ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : (
        <Empty icon={<Play />} title={children} />
      )}
    </Panel>
  );
}

/* ---------- Search ---------- */

function SearchPlay() {
  const [queries, setQueries] = useState("");
  const [maxResults, setMaxResults] = useState(5);
  const [range, setRange] = useState("");
  const [engine, setEngine] = useState("auto");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const run = useMutation({ mutationFn: api.playSearch });
  const domains = (text: string) => {
    const list = text.split(/[\s,]+/).filter(Boolean);
    return list.length > 0 ? list : undefined;
  };
  const list = queries
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
  const submit = () => list.length > 0 && run.mutate({ queries: list, maxResults, time_range: range || undefined, search_engine: engine, include_domains: domains(include), exclude_domains: domains(exclude) });

  return (
    <Layout
      form={
        <div className="flex flex-col gap-4">
          <Field label="查询" hint="每行一条，多条并行执行（⌘/Ctrl + Enter 发送）">
            <Textarea rows={4} value={queries} placeholder={"go 1.27 release notes\nmcp streamable http spec"} onChange={(e) => setQueries(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()} />
          </Field>
          <Field label="搜索引擎">
            <EngineSelect tool="search" value={engine} onChange={setEngine} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="每条结果数">
              <NumberInput min={1} value={maxResults} onChange={(v) => setMaxResults(Math.round(v))} />
            </Field>
            <Field label="时间范围">
              <Select value={range} onChange={(e) => setRange(e.target.value)}>
                <option value="">不限</option>
                <option value="day">一天内</option>
                <option value="week">一周内</option>
                <option value="month">一月内</option>
                <option value="year">一年内</option>
              </Select>
            </Field>
          </div>
          <Field label="只要这些域名" hint="include_domains，逗号或空格分隔，含子域名">
            <Input mono value={include} placeholder="docs.python.org, github.com" onChange={(e) => setInclude(e.target.value)} />
          </Field>
          <Field label="排除这些域名" hint="exclude_domains">
            <Input mono value={exclude} placeholder="pinterest.com" onChange={(e) => setExclude(e.target.value)} />
          </Field>
          <Button variant="primary" icon={<Play />} loading={run.isPending} disabled={list.length === 0} onClick={submit}>
            搜索
          </Button>
        </div>
      }
    >
      <Failure error={run.error} />
      {run.data ? (
        <>
          <ResultMeta ms={run.data.duration_ms}>
            <span>
              {run.data.results.length} 条查询 · {run.data.results.reduce((n, r) => n + (r.web?.length ?? 0) + (r.videos?.length ?? 0), 0)} 条结果
            </span>
          </ResultMeta>
          <div className="flex flex-col gap-4">
            {run.data.results.map((result) => (
              <SearchResultPanel key={result.query} result={result} />
            ))}
          </div>
        </>
      ) : (
        !run.error && <Idle pending={run.isPending}>输入查询后发起搜索</Idle>
      )}
    </Layout>
  );
}

function SearchResultPanel({ result }: { result: SearchResult }) {
  const items = [...(result.web ?? []), ...(result.videos ?? [])];
  return (
    <Panel title={result.query} actions={result.search_engine && <Badge tone="signal">{result.search_engine}</Badge>} flush>
      {result.error ? (
        <div className="p-4 text-sm text-err">{result.error}</div>
      ) : items.length === 0 ? (
        <Empty title="没有结果" />
      ) : (
        <ol>
          {items.map((item, i) => (
            <li key={`${item.url}-${i}`} className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0">
              <span className="tag w-4 pt-0.5">{String(i + 1).padStart(2, "0")}</span>
              <div className="min-w-0 flex-1">
                <a href={item.url} target="_blank" rel="noreferrer" className="group flex items-center gap-1.5 text-sm font-medium hover:text-signal-text">
                  <span className="truncate">{item.title || item.url}</span>
                  <ExternalLink className="size-3 shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
                </a>
                <div className="num truncate text-xs text-ink-3">{item.url}</div>
                {item.description ? <p className="mt-1 line-clamp-3 text-xs text-ink-2">{item.description}</p> : <p className="mt-1 text-xs text-ink-3">（提供商没有返回摘要）</p>}
                {(item.age || item.duration) && <div className="tag mt-1 normal-case">{[item.age, item.duration].filter(Boolean).join(" · ")}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/* ---------- Fetch ---------- */

function FetchPlay() {
  const { config } = useConfig();
  const canExtract = config.fetch.extract.models.length > 0;
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [raw, setRaw] = useState(!canExtract);
  const [offset, setOffset] = useState(0);
  const [engine, setEngine] = useState("auto");
  const run = useMutation({ mutationFn: api.playFetch });
  const submit = (at = offset, asRaw = raw) => url.trim() && run.mutate({ url: url.trim(), prompt: asRaw ? "" : prompt, raw: asRaw, offset: at, fetch_engine: engine });

  return (
    <Layout
      form={
        <div className="flex flex-col gap-4">
          <Field label="URL">
            <Input mono value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          </Field>
          <Field label="抓取引擎">
            <EngineSelect tool="fetch" value={engine} onChange={setEngine} />
          </Field>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-ink-2">返回原始页面</div>
              <div className="text-xs text-ink-3">关闭后由提取模型按 prompt 作答</div>
            </div>
            <Switch checked={raw} onCheckedChange={setRaw} aria-label="返回原始页面" />
          </div>
          {raw ? (
            <Field label="起始偏移" hint="长页面分段读取时使用，单位是字节">
              <NumberInput min={0} value={offset} onChange={(v) => setOffset(Math.round(v))} />
            </Field>
          ) : (
            <Field label="Prompt" hint={canExtract ? "想从页面里知道什么" : "尚未配置提取模型，将退回原始页面"}>
              <Textarea rows={3} value={prompt} placeholder="这个版本有哪些破坏性变更？" onChange={(e) => setPrompt(e.target.value)} />
            </Field>
          )}
          <Button variant="primary" icon={<Play />} loading={run.isPending} disabled={!url.trim()} onClick={() => submit()}>
            抓取
          </Button>
        </div>
      }
    >
      <Failure error={run.error} />
      {run.data ? (
        <FetchResultView
          result={run.data.result}
          ms={run.data.duration_ms}
          onNext={(next) => {
            setRaw(true);
            setOffset(next);
            submit(next, true);
          }}
        />
      ) : (
        !run.error && <Idle pending={run.isPending}>输入 URL 后发起抓取</Idle>
      )}
    </Layout>
  );
}

function FetchResultView({ result, ms, onNext }: { result: FetchResult; ms: number; onNext: (offset: number) => void }) {
  const body = result.answer ?? result.content ?? "";
  return (
    <>
      <ResultMeta ms={ms}>
        {result.fetch_engine && <Badge tone="signal">{result.fetch_engine}</Badge>}
        {result.content_length !== undefined && <span className="num">全文 {compact(result.content_length)} 字节</span>}
        {result.covered && (
          <span className="num">
            本段 {result.covered[0]}–{result.covered[1]}
          </span>
        )}
        {result.answer !== undefined && <Badge tone="info">模型提取</Badge>}
      </ResultMeta>
      <div className="flex flex-col gap-3">
        {result.error && <Notice tone="err">{result.error}</Notice>}
        {result.warning && <Notice tone="warn">{result.warning}</Notice>}
        {result.answer_truncated && <Notice tone="warn">模型输出在超时前没有写完，以下是已收到的部分。</Notice>}
        {(result.title || body) && (
          <Panel title={result.title || "（无标题）"} description={result.description} flush>
            <CodeBlock copy wrap className="max-h-[70vh] rounded-none border-0">
              {body}
            </CodeBlock>
          </Panel>
        )}
        {result.next_offset !== undefined && result.next_offset > 0 && (
          <div>
            <Button onClick={() => onNext(result.next_offset!)}>读取下一段（偏移 {result.next_offset}）</Button>
          </div>
        )}
      </div>
    </>
  );
}

/* ---------- Research ---------- */

function ResearchPlay() {
  const { config } = useConfig();
  const [question, setQuestion] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const start = useMutation({ mutationFn: api.startResearch, onSuccess: (data) => setTaskId(data.task_id) });
  const task = useQuery({
    queryKey: ["research-task", taskId],
    queryFn: () => api.researchTask(taskId!),
    enabled: taskId !== null,
    refetchInterval: (query) => (query.state.data?.status === "running" || !query.state.data ? 1500 : false),
  });
  const running = start.isPending || (taskId !== null && (!task.data || task.data.status === "running"));

  if (!config.research.enabled) {
    return (
      <Panel>
        <Empty title="深度研究尚未启用">
          到{" "}
          <Link href="/research" className="text-ink underline underline-offset-2">
            深度研究
          </Link>{" "}
          页选好模型并启用（记得保存）。
        </Empty>
      </Panel>
    );
  }
  return (
    <Layout
      form={
        <div className="flex flex-col gap-4">
          <Field label="研究问题" hint={`预算：${config.research.max_steps} 步 · ${config.research.max_duration_seconds} 秒 · ${compact(config.research.max_tokens)} token`}>
            <Textarea rows={6} value={question} placeholder="对比 2026 年主流网页抓取 API 的定价与限流策略" onChange={(e) => setQuestion(e.target.value)} />
          </Field>
          <Button variant="primary" icon={<Play />} loading={running} disabled={!question.trim()} onClick={() => start.mutate(question.trim())}>
            开始研究
          </Button>
        </div>
      }
    >
      <Failure error={start.error ?? task.error} />
      {task.data ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <Badge tone={task.data.status === "done" ? "ok" : task.data.status === "failed" ? "err" : "signal"} dot>
              {task.data.status === "done" ? "完成" : task.data.status === "failed" ? "失败" : "研究中"}
            </Badge>
            <span className="num">{duration(task.data.updated_at - task.data.created_at)}</span>
            <span className="num truncate">{task.data.id}</span>
          </div>
          {task.data.status === "running" && (
            <Panel>
              <div className="flex items-center gap-3 text-sm">
                <Spinner />
                <span className="num min-w-0 truncate text-xs text-ink-2">{task.data.progress || "正在规划…"}</span>
              </div>
            </Panel>
          )}
          {task.data.error && <Notice tone="err">{task.data.error}</Notice>}
          {task.data.result && (
            <Panel title="研究报告" flush>
              <CodeBlock copy wrap className="max-h-[70vh] rounded-none border-0">
                {task.data.result}
              </CodeBlock>
            </Panel>
          )}
        </div>
      ) : (
        !start.error && <Idle pending={running}>提出一个需要多方查证的问题</Idle>
      )}
    </Layout>
  );
}
