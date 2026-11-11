import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Braces, ExternalLink, FileText, Flag, History, MessageSquareText, RotateCcw, ScrollText, Search, SlidersHorizontal, Square, Undo2, Workflow } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { FlowView, TimelineView } from "../../components/flow/FlowView";
import { hasOtherModels, ModelOverride } from "../../components/ModelPicker";
import {
  api,
  APIError,
  type BudgetOverride,
  type Research,
  type ResearchBudget,
  type ResearchLimit,
  type ResearchSpent,
  type ResearchStep,
  type ResearchTask,
  type ResearchTaskSummary,
} from "../../lib/api";
import { useConfig } from "../../lib/config";
import { ago, compact, duration, percent } from "../../lib/format";
import { useNow, useTween } from "../../lib/motion";
import { useLiveCall } from "../../lib/trace";
import { Markdown } from "../../ui/markdown";
import { Drawer, Popover, useConfirm, useToast } from "../../ui/overlays";
import { Button, CodeBlock, CopyButton, cx, Dot, Empty, iconButton, Loading, Notice, NumberInput, Segmented, Skeleton, TabList, Tabs, Tooltip, type Tone } from "../../ui/primitives";
import { budgetInfo, readingText } from "../../lib/research";
import { Chip, CodeButton, Composer, Examples, Group, host, LocalNotice, LocalTag, onModEnter, OptionGroup, ResetButton, RunButton, Stage, TabPanel } from "./kit";

/** Where the task on show is remembered, so a reload returns to it. */
const taskKey = "seekmux-play-research-task";

type LimitKey = "max_steps" | "max_duration_seconds" | "max_tokens" | "max_context_tokens";

// What a run may be given; the ceilings match the server's (app.maxResearchSteps, app.maxResearchDuration).
const limits: { key: LimitKey; label: string; suffix: string; min: number; max: number }[] = [
  { key: "max_steps", label: "最大步数", suffix: "步", min: 1, max: 200 },
  { key: "max_duration_seconds", label: "最长用时", suffix: "秒", min: 30, max: 3600 },
  { key: "max_tokens", label: "Token 上限", suffix: "token", min: 1000, max: 1e9 },
  { key: "max_context_tokens", label: "上下文上限", suffix: "token", min: 1000, max: 1e9 },
];

const limitLabel: Record<ResearchLimit, string> = { steps: "步数", duration: "用时", tokens: "Token", context: "上下文" };

const statusMeta: Record<ResearchTaskSummary["status"], { tone: Tone; label: string }> = {
  running: { tone: "signal", label: "研究中" },
  done: { tone: "ok", label: "完成" },
  failed: { tone: "err", label: "失败" },
  canceled: { tone: "neutral", label: "已停止" },
};

/** Minutes and seconds, the way a stopwatch shows them. */
function stopwatch(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const budgetText = (b: Pick<ResearchBudget, LimitKey>) => `${b.max_steps} 步 · ${stopwatch(b.max_duration_seconds * 1000)} · ${compact(b.max_tokens)} token · 上下文 ${compact(b.max_context_tokens)}`;
const budgetChipText = (b: Pick<ResearchBudget, LimitKey>) => `${b.max_steps} 步 · ${stopwatch(b.max_duration_seconds * 1000)} · ${compact(b.max_tokens)}`;

export function ResearchPlay() {
  const { config } = useConfig();
  const client = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const saved = config.research;
  const assigned = saved.model ? [saved.model] : [];

  const [question, setQuestion] = useState("");
  const [model, setModel] = useState("");
  // Only what differs from the configuration; the rest follows it.
  const [override, setOverride] = useState<BudgetOverride>({});
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(() => sessionStorage.getItem(taskKey));
  const show = (id: string | null) => {
    setTaskId(id);
    if (id) sessionStorage.setItem(taskKey, id);
    else sessionStorage.removeItem(taskKey);
  };

  const budget = { ...saved, ...override };
  const changed = Object.keys(override).length;
  const set = <K extends keyof BudgetOverride>(key: K, value: BudgetOverride[K]) =>
    setOverride(({ [key]: _, ...rest }) => (value === saved[key] ? rest : { ...rest, [key]: value }) as BudgetOverride);

  const start = useMutation({
    mutationFn: api.startResearch,
    onSuccess: (data) => {
      show(data.task_id);
      void client.invalidateQueries({ queryKey: ["research-tasks"] });
    },
  });
  const task = useQuery({
    queryKey: ["research-task", taskId],
    queryFn: () => api.researchTask(taskId!),
    enabled: taskId !== null,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1000 : false),
  });
  const data = taskId !== null ? task.data : undefined;
  const running = data?.status === "running";
  // A task that is gone, pruned with the logs of its day, is nothing to return to.
  const gone = task.error instanceof APIError && task.error.status === 404;
  useEffect(() => {
    if (gone) show(null);
  }, [gone]);

  const tasks = useQuery({
    queryKey: ["research-tasks"],
    queryFn: api.researchTasks,
    refetchInterval: (query) => (query.state.data?.some((t) => t.status === "running") ? 3000 : false),
  });
  const status = data?.status;
  const { refetch: refetchTasks } = tasks;
  useEffect(() => {
    if (status) void refetchTasks();
  }, [status, refetchTasks]);

  const ready = question.trim() !== "" && saved.enabled;
  const submit = () => {
    if (!ready || running || start.isPending) return;
    // The run is what to watch from here on.
    setOpen(false);
    start.mutate({ question: question.trim(), model: model || undefined, budget: changed > 0 ? override : undefined });
  };
  const stop = async () => {
    if (!data) return;
    if (!(await confirm({ title: "停止这次研究？", body: "不会生成报告。", confirm: "停止", danger: true }))) return;
    try {
      await api.cancelResearch(data.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "err");
    }
    void task.refetch();
  };
  /** Takes the question and the settings of a past run back into the composer. */
  const reuse = (from: ResearchTask | ResearchTaskSummary) => {
    setQuestion(from.question);
    const b = from.budget;
    if (!b) return;
    setModel(b.model !== saved.model && config.llm.providers.some((p) => p.models.some((m) => m.id === b.model)) ? b.model : "");
    const next: BudgetOverride = {};
    for (const { key } of limits) if (b[key] !== saved[key]) next[key] = b[key];
    if (b.reading !== saved.reading) next.reading = b.reading;
    setOverride(next);
  };

  return (
    <Stage
      tool="research"
      title="深度研究"
      history={<Tasks tasks={tasks.data} pending={tasks.isPending} days={config.logs.retention_days} active={taskId} onPick={show} onReuse={reuse} />}
      output={
        taskId !== null && !gone ? (
          data ? (
            // The clock of the server, so a run is timed the same wherever the console is opened.
            <Run key={data.id} task={data} skew={data.now - task.dataUpdatedAt} onStop={() => void stop()} onReuse={() => reuse(data)} onClose={() => show(null)} />
          ) : (
            task.error ? (
              <section className="grid min-h-56 place-items-center rounded-panel border border-line bg-surface p-4">
                <Notice tone="err">{task.error.message}</Notice>
              </section>
            ) : (
              <Skeleton panel className="h-[26rem]" />
            )
          )
        ) : (
          <section className="grid min-h-56 place-items-center rounded-panel border border-line bg-surface">
            <Empty icon={<Workflow />} title="运行后显示研究过程" />
          </section>
        )
      }
    >
      {!saved.enabled && (
        <Notice tone="warn">
          深度研究未启用，
          <Link href="/tools/research" className="text-ink underline underline-offset-2">
            去启用
          </Link>
        </Notice>
      )}
      <Composer
        open={open}
        splitPanel={false}
        tools={
          <>
            <Segmented
              size="sm"
              value={budget.reading}
              onChange={(reading: Research["reading"]) => set("reading", reading)}
              options={[
                { value: "raw", label: "读原文" },
                { value: "extract", label: "读归纳" },
              ]}
            />
            {saved.enabled &&
              (hasOtherModels(config, assigned) ? (
                <Popover className="w-84 p-2" trigger={<Chip icon={<Bot />} label="模型" value={<span className="num">{model || saved.model}</span>} changed={model !== ""} />}>
                  <ModelOverride assigned={assigned} value={model} onChange={setModel} />
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-2 pb-0.5 text-xs text-ink-3">
                    <LocalTag />
                    研究全程只用这一个模型，不做故障转移。
                  </p>
                </Popover>
              ) : (
                saved.model && (
                  <span className="inline-flex h-7 items-center gap-1.5 rounded-ctl border border-line bg-surface px-2.5 text-xs text-ink-3">
                    <Bot className="size-3.5" />
                    <span className="num text-ink-2">{saved.model}</span>
                  </span>
                )
              ))}
            <Chip
              icon={<SlidersHorizontal />}
              label="预算"
              value={<span className="num">{budgetChipText(budget)}</span>}
              aria-expanded={open}
              aria-pressed={open}
              changed={changed > 0}
              onClick={() => setOpen(!open)}
            />
          </>
        }
        toolbarRight={
          <CodeButton
            tool="research"
            args={{ question: question.trim() }}
            notices={<LocalNotice items={[model && `模型 ${model}`, changed > 0 && `临时预算（${budgetText(budget)}${override.reading ? `，${override.reading === "raw" ? "读原文" : "读归纳"}` : ""}）`]} />}
          />
        }
        panel={
          <OptionGroup title="本次运行预算与读取方式" local action={changed > 0 && <ResetButton onClick={() => setOverride({})} />}>
            <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2 @4xl:grid-cols-4">
              {limits.map((limit) => {
                const base = saved[limit.key];
                return (
                  <Group key={limit.key} label={limit.label} info={budgetInfo[limit.key]}>
                    <div className="flex items-center gap-1">
                      <NumberInput
                        className="min-w-0 flex-1"
                        min={limit.min}
                        suffix={limit.suffix}
                        value={budget[limit.key]}
                        aria-label={limit.label}
                        onChange={(v) => set(limit.key, Math.min(limit.max, Math.round(v)))}
                      />
                      {budget[limit.key] !== base && (
                        <Tooltip content={`恢复配置值 ${base}`}>
                          <Button size="sm" variant="ghost" icon={<RotateCcw />} aria-label={`恢复${limit.label}的配置值`} onClick={() => set(limit.key, base)} />
                        </Tooltip>
                      )}
                    </div>
                  </Group>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs text-ink-3">
              <span>{readingText(budget.reading, config.fetch.extract.models.length > 0)}</span>
              <Link href="/tools/research" className="text-ink-2 underline underline-offset-2 hover:text-ink">
                修改已保存的设置
              </Link>
            </div>
          </OptionGroup>
        }
        footer={
          saved.enabled && (
            <Examples
              mono={false}
              items={["对比 Brave、Exa、Tavily 搜索 API 的定价与限流", "SQLite WAL 模式在高并发写入下的取舍"]}
              current={question}
              onPick={setQuestion}
              onClear={() => setQuestion("")}
            />
          )
        }
        actions={<RunButton label="开始研究" loading={start.isPending || running} disabled={!ready || running} onClick={submit} onStop={running ? () => void stop() : undefined} />}
      >
        <div className="flex items-start px-3.5 py-2.5">
          <span className="tag w-12 shrink-0 pt-1 text-ink-3">课题</span>
          <textarea
            rows={3}
            value={question}
            aria-label="研究问题"
            disabled={!saved.enabled}
            placeholder="写下需要多方查证的问题，并说明背景、约束和期望的报告结构"
            className="min-w-0 flex-1 resize-none bg-transparent text-sm leading-6 text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onModEnter(submit)}
          />
        </div>
      </Composer>

      {start.error && <Notice tone="err">{start.error.message}</Notice>}
    </Stage>
  );
}

/* ---------- A run ---------- */

/** What a task has used, also for one recorded before runs reported it. */
function spentOf(task: ResearchTaskSummary): ResearchSpent {
  return task.spent ?? { steps: 0, searches: 0, fetches: 0, input_tokens: 0, output_tokens: 0, context_tokens: 0, ...task.stats };
}

interface Row {
  at: number;
  step?: number;
  kind: NonNullable<ResearchStep["kind"]> | "line";
  text: string;
}

/** Reads a step of either shape; an old one says what it is at the start of its line. */
function rowOf({ at, step, kind, text, line = "" }: ResearchStep): Row {
  if (kind) return { at, step, kind, text: text ?? "" };
  const [, known, rest] = /^(search|fetch): (.*)$/s.exec(line) ?? [];
  return known ? { at, kind: known as "search" | "fetch", text: rest } : { at, kind: "line", text: line };
}

function Run({ task, skew, onStop, onReuse, onClose }: { task: ResearchTask; skew: number; onStop: () => void; onReuse: () => void; onClose: () => void }) {
  const live = task.status === "running";
  const now = useNow(live);
  const elapsed = live ? Math.max(0, now + skew - task.created_at) : task.updated_at - task.created_at;
  const spent = spentOf(task);
  const budget = task.budget;
  const rows = task.steps.map(rowOf);
  const last = rows.at(-1);
  const meta = statusMeta[task.status];

  // The flow of the run: followed live while it runs, read from its log entry afterwards.
  // A run that was watched keeps what it was told until its entry is there.
  const [watched] = useState(live);
  const stored = useQuery({
    queryKey: ["research-log", task.id],
    queryFn: () => (task.log_id ? api.log(task.log_id) : api.logByCall(task.call_id!)),
    enabled: !live && Boolean(task.log_id || task.call_id),
    // The entry is written a moment after the run ends.
    retry: 8,
    retryDelay: 400,
    staleTime: Infinity,
  });
  const trace = stored.data?.trace?.length ? stored.data.trace : undefined;
  const flying = useLiveCall(watched && task.call_id && !trace ? task.call_id : undefined);
  const following = live && flying.nodes.length > 0;
  const nodes = trace ?? flying.nodes;
  const origin = flying.origin || task.created_at - skew;
  // What the model writes in the step under way reaches here sooner than the task's draft does.
  const writing = following ? flying.nodes.findLast((n) => n.kind === "step" && n.status === "running") : undefined;
  const draft = (writing && flying.text[writing.id]) || task.draft || "";
  const body = task.result || draft;

  const [view, setView] = useState<"flow" | "timeline" | "report">(live || !body ? "flow" : "report");
  const [selected, setSelected] = useState(0);
  const [format, setFormat] = useState<"rendered" | "text">("rendered");
  const [expanded, setExpanded] = useState(false);
  const longQuestion = task.question.length > 100 || task.question.includes("\n");
  // The report is what a finished run is opened for, unless the user is inspecting the flow or timeline.
  const touched = useRef(false);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live && !touched.current && (task.result || task.draft)) setView("report");
    wasLive.current = live;
  }, [live, task.draft, task.result]);
  const pickView = (next: "flow" | "timeline" | "report") => {
    touched.current = true;
    setView(next);
  };
  const selectNode = (id: number) => {
    setSelected(id);
    if (id !== 0) touched.current = true;
  };
  // Under a narrow window the run sits below the composer, where a new one would go unseen.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (wasLive.current && task.steps.length === 0 && node && node.getBoundingClientRect().top > window.innerHeight * 0.6) node.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const phase = !live
    ? null
    : spent.exhausted
      ? `${limitLabel[spent.exhausted]}预算用尽，正在撰写报告`
      : draft
        ? "模型正在输出"
        : last?.kind === "search" && last.step === spent.steps
          ? "正在搜索，等待结果"
          : last?.kind === "dev_search" && last.step === spent.steps
            ? "正在搜索开发资料，等待结果"
            : last?.kind === "fetch" && last.step === spent.steps
              ? `正在读取 ${host(last.text)}`
              : spent.steps <= 1 && rows.length === 0
                ? "正在规划"
                : "模型正在思考下一步";

  const record = stored.data ? String(stored.data.id) : live ? task.call_id : undefined;
  // The flow is still on its way: the stream has not answered yet, or the entry is not written yet.
  const loading = nodes.length === 0 && ((live && Boolean(task.call_id) && !flying.gone) || (!live && stored.isPending && stored.fetchStatus !== "idle"));

  return (
    // No overflow clipping here: the panes inside clip themselves.
    <section ref={ref} className="@container flex min-h-[32rem] min-w-0 scroll-mt-6 flex-col rounded-panel border border-line bg-surface">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1 basis-72">
          <div className="flex items-center gap-2 text-xs">
            <span className={cx("flex items-center gap-1.5 font-medium", live ? "text-signal-text" : "text-ink-2")}>
              <Dot tone={meta.tone} live={live} />
              {meta.label}
            </span>
            {phase && <span className="min-w-0 truncate text-ink-3">{phase}</span>}
          </div>
          <h2 className={cx("mt-1 text-base font-medium whitespace-pre-line", !expanded && "line-clamp-2")}>{task.question}</h2>
          {longQuestion && (
            <button type="button" onClick={() => setExpanded(!expanded)} className="mt-0.5 text-xs text-ink-3 underline underline-offset-2 hover:text-ink">
              {expanded ? "收起问题" : "展开全文"}
            </button>
          )}
          <div className="num mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
            {budget && <span className="text-ink-2">{budget.model}</span>}
            {budget && <span>{budget.reading === "raw" ? "读原文" : "读归纳"}</span>}
            <span>
              搜索 <Count value={spent.searches} />
              {(spent.dev_searches ?? 0) > 0 && (
                <>
                  {" "}
                  · 开发资料 <Count value={spent.dev_searches ?? 0} />
                </>
              )}{" "}
              · 读取 <Count value={spent.fetches} />
            </span>
            <span>{task.id}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={onReuse}>
            载入设置
          </Button>
          {live ? (
            <Button size="sm" variant="danger" icon={<Square />} onClick={onStop}>
              停止
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onClose}>
              关闭
            </Button>
          )}
        </div>
      </header>

      <Gauges spent={spent} budget={budget} elapsed={elapsed} live={live} />

      <Tabs value={view} onChange={pickView} className="flex-1">
        <TabList
          tabs={[
            {
              value: "flow",
              label: (
                <>
                  流程{live && <Dot tone="signal" live />}
                </>
              ),
            },
            { value: "timeline", label: "时间轴" },
            {
              value: "report",
              label: (
                <>
                  报告{live && draft && <Dot tone="signal" live />}
                </>
              ),
            },
          ]}
          actions={
            <>
              {view === "report" && task.result && (
                <>
                  {task.status === "done" && (
                    <>
                      <Tooltip content="报告的独立页面，无需登录即可阅读">
                        <a
                          href={task.report_url}
                          target="_blank"
                          rel="noreferrer"
                          className="press inline-flex h-7 items-center gap-1 rounded-ctl px-2.5 text-xs text-ink-2 hover:bg-fill hover:text-ink"
                        >
                          <ExternalLink className="size-3.5 text-ink-3" />
                          报告页
                        </a>
                      </Tooltip>
                      <CopyButton text={task.report_url} label="复制链接" />
                    </>
                  )}
                  <CopyButton text={task.result} label="复制" />
                  <Segmented
                    size="sm"
                    value={format}
                    onChange={setFormat}
                    options={[
                      { value: "rendered", label: "渲染" },
                      { value: "text", label: "文本" },
                    ]}
                  />
                </>
              )}
              {record && (
                <Tooltip content="在请求日志里打开这次研究的完整记录">
                  <Link href={`/logs/${record}`} className={iconButton("sm")} aria-label="完整记录">
                    <ScrollText />
                  </Link>
                </Tooltip>
              )}
            </>
          }
        />
        <TabPanel value="flow" className="flex flex-col">
          {nodes.length > 0 ? (
            <FlowView
              nodes={nodes}
              text={trace ? undefined : flying.text}
              live={following}
              origin={origin}
              selected={selected}
              onSelect={selectNode}
              className="flex-1 overflow-hidden rounded-b-panel"
            />
          ) : loading ? (
            <Loading rows={6} />
          ) : (
            // A run from before flows were recorded, or one whose log entry is gone: what it left is its steps.
            <StepList rows={rows} live={live} phase={phase} elapsed={elapsed} />
          )}
        </TabPanel>
        <TabPanel value="timeline" className="flex flex-col">
          {nodes.length > 0 ? (
            <TimelineView
              nodes={nodes}
              text={trace ? undefined : flying.text}
              live={following}
              origin={origin}
              selected={selected}
              onSelect={selectNode}
              className="flex-1 overflow-hidden rounded-b-panel"
            />
          ) : (
            loading ? <Loading rows={6} /> : <div className="grid place-items-center px-6 py-16 text-center text-xs text-ink-3">没有流程记录</div>
          )}
        </TabPanel>
        <TabPanel value="report">
          <Report task={task} draft={draft} spent={spent} rendered={format === "rendered"} />
        </TabPanel>
      </Tabs>
    </section>
  );
}

/** A whole number that counts up to its new value. */
function Count({ value, format = String }: { value: number; format?: (n: number) => string }) {
  return <>{format(Math.round(useTween(value)))}</>;
}

/* ---------- Budget gauges ---------- */

function Gauges({ spent, budget, elapsed, live }: { spent: ResearchSpent; budget: ResearchBudget | undefined; elapsed: number; live: boolean }) {
  const tokens = spent.input_tokens + spent.output_tokens;
  const maxMs = budget ? budget.max_duration_seconds * 1000 : undefined;
  const wrapUp = maxMs ? maxMs * 0.8 : 0;
  // The step past the budget is the report, which is not a step of the research.
  const steps = budget ? Math.min(spent.steps, budget.max_steps) : spent.steps;
  const cached = spent.cache_read_tokens ?? 0;
  return (
    <div className="grid grid-cols-2 gap-px border-b border-line bg-line @3xl:grid-cols-4">
      <Gauge
        label="步数"
        value={steps}
        limit={budget?.max_steps}
        live={live}
        spent={spent.exhausted === "steps"}
        cells={budget && budget.max_steps <= 48 ? budget.max_steps : undefined}
        foot={!budget ? "模型推理的轮数" : spent.exhausted && live ? "已停止检索，撰写报告" : live ? `剩余 ${budget.max_steps - steps} 步` : `上限 ${budget.max_steps} 步`}
      />
      <Gauge
        label="用时"
        value={elapsed}
        limit={maxMs}
        format={stopwatch}
        live={live}
        steady
        spent={spent.exhausted === "duration"}
        mark={0.8}
        foot={!maxMs ? "自开始以来" : live && elapsed < wrapUp ? `${stopwatch(wrapUp)} 进入收尾` : live ? "已进入收尾" : `收尾阈值 ${stopwatch(wrapUp)}`}
      />
      <Gauge
        label="Token"
        value={tokens}
        limit={budget?.max_tokens}
        format={compact}
        live={live}
        spent={spent.exhausted === "tokens"}
        foot={
          <>
            输入 <Count value={spent.input_tokens} format={compact} /> · 输出 <Count value={spent.output_tokens} format={compact} />
            {cached > 0 && ` · 缓存命中 ${percent(cached, spent.input_tokens)}`}
          </>
        }
      />
      <Gauge
        label="上下文"
        value={spent.context_tokens}
        limit={budget?.max_context_tokens}
        format={compact}
        live={live}
        spent={spent.exhausted === "context"}
        foot="下一次请求的估算规模"
      />
    </div>
  );
}

/**
 * One limit of the budget and how much of it is used. The number and the bar
 * follow the value instead of jumping to it; `steady` is for a value that
 * already moves by itself, the clock.
 */
function Gauge({
  label,
  value,
  limit,
  format = String,
  live,
  steady,
  spent,
  mark,
  cells,
  foot,
}: {
  label: string;
  value: number;
  /** Absent for a run recorded without its budget. */
  limit?: number;
  format?: (n: number) => string;
  live: boolean;
  steady?: boolean;
  /** This limit is the one that ended the research. */
  spent: boolean;
  /** A point of the bar to mark, as a share of the limit. */
  mark?: number;
  /** Draws the bar as this many cells, one per unit. */
  cells?: number;
  foot: ReactNode;
}) {
  const tween = useTween(value);
  const shown = steady ? value : tween;
  const ratio = limit ? Math.min(1, value / limit) : 0;
  const hot = spent || ratio >= 0.85;
  const fill = hot ? "bg-warn" : live ? "bg-signal-text" : "bg-ink-3";
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="tag">{label}</span>
        {spent ? <span className="text-2xs text-warn">已用尽</span> : limit ? <span className="num text-2xs text-ink-3">{Math.round(ratio * 100)}%</span> : null}
      </div>
      <div className="num flex items-baseline gap-1.5 truncate">
        <span className={cx("text-xl font-medium", hot && "text-warn")}>{format(Math.round(shown))}</span>
        {limit !== undefined && <span className="text-xs text-ink-3">/ {format(limit)}</span>}
      </div>
      {cells ? (
        <div className="flex h-1.5 gap-0.5" role="meter" aria-label={label} aria-valuenow={value} aria-valuemax={limit}>
          {Array.from({ length: cells }, (_, i) => (
            <span
              key={i}
              className={cx(
                "flex-1 rounded-full transition-colors duration-500 ease-settle",
                i < value ? fill : "bg-fill-strong",
                // The step under way.
                live && !spent && i === value - 1 && "animate-pulse-dot",
              )}
            />
          ))}
        </div>
      ) : (
        <div className="relative h-1.5 rounded-full bg-fill-strong" role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemax={limit}>
          <span
            className={cx("absolute inset-y-0 left-0 rounded-full transition-[width,background-color]", steady ? "duration-300 ease-linear" : "duration-700 ease-settle", fill)}
            style={{ width: `${ratio * 100}%` }}
          />
          {mark !== undefined && limit !== undefined && <span className="absolute -inset-y-0.5 w-px bg-ink-2" style={{ left: `${mark * 100}%` }} />}
        </div>
      )}
      <div className="truncate text-xs text-ink-3">{foot}</div>
    </div>
  );
}

/* ---------- Steps ---------- */

const rowIcon = { search: Search, dev_search: Braces, fetch: FileText, note: MessageSquareText, wrap_up: Flag, line: FileText };

/** The steps of a run as the task recorded them, for a run that has no flow. */
function StepList({ rows, live, phase, elapsed }: { rows: Row[]; live: boolean; phase: string | null; elapsed: number }) {
  // The list follows its newest row while the reader stays at its end.
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && live && pinned.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, live, phase]);

  if (rows.length === 0 && !live) return <Empty title="没有步骤记录" />;

  // Rows of one model round sit under its number; an old task has no rounds.
  const groups: { step: number | undefined; rows: Row[] }[] = [];
  for (const row of rows) {
    const group = groups.at(-1);
    if (group && group.step === row.step) group.rows.push(row);
    else groups.push({ step: row.step, rows: [row] });
  }

  return (
    <div
      ref={box}
      className={cx(live && "max-h-[32rem] overflow-y-auto")}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      <ol>
        {groups.map((group, i) => (
          <li key={i} className={cx("flex gap-3 border-b border-line px-4 py-3", live && "animate-in")}>
            <div className="w-10 shrink-0">
              {group.step !== undefined && <div className="num text-sm text-ink-2">{String(group.step).padStart(2, "0")}</div>}
              <div className="num text-2xs text-ink-3">{stopwatch(group.rows[0].at)}</div>
            </div>
            <ol className="flex min-w-0 flex-1 flex-col gap-2">
              {group.rows.map((row, n) => {
                const Icon = rowIcon[row.kind];
                return (
                  <li key={n} className={cx("flex min-w-0 gap-2.5", live && "animate-in")}>
                    <Icon className={cx("mt-0.5 size-3.5 shrink-0", row.kind === "wrap_up" ? "text-warn" : "text-ink-3")} />
                    <RowBody row={row} />
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
      {live && (
        <div className="flex items-center gap-3 px-4 py-3 text-xs text-ink-2">
          <span className="num w-10 shrink-0 text-2xs text-ink-3">{stopwatch(elapsed)}</span>
          <Dot tone="signal" live />
          <span className="min-w-0 truncate">{phase}</span>
        </div>
      )}
    </div>
  );
}

function RowBody({ row }: { row: Row }) {
  switch (row.kind) {
    case "search":
      return (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {row.text.split(" | ").map((query, i) => (
            <span key={i} className="num max-w-full truncate rounded-tag bg-fill px-1.5 py-px text-xs text-ink">
              {query}
            </span>
          ))}
        </div>
      );
    case "dev_search":
      // Told apart from a web search by its icon and its label: it asks a different index.
      return (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="tag shrink-0">开发资料</span>
          <span className="min-w-0 text-xs break-words text-ink">{row.text}</span>
        </div>
      );
    case "fetch": {
      const site = host(row.text);
      const rest = row.text.replace(/^[a-z]+:\/\/(www\.)?/i, "").slice(site.length);
      return (
        <a href={row.text} target="_blank" rel="noreferrer" title={row.text} className="num min-w-0 truncate text-xs hover:text-signal-text">
          <span className="text-ink">{site}</span>
          <span className="text-ink-3">{rest}</span>
        </a>
      );
    }
    case "note":
      return <p className="line-clamp-4 min-w-0 text-xs whitespace-pre-line text-ink-2">{row.text}</p>;
    case "wrap_up":
      return <span className="text-xs text-warn">{row.text in limitLabel ? `${limitLabel[row.text as ResearchLimit]}预算用尽` : "预算用尽"}，停止检索，开始撰写报告</span>;
    default:
      return <span className="num min-w-0 text-xs break-words text-ink-2">{row.text}</span>;
  }
}

/* ---------- Report ---------- */

function Report({ task, draft, spent, rendered }: { task: ResearchTask; draft: string; spent: ResearchSpent; rendered: boolean }) {
  const live = task.status === "running";
  // A run recorded before limits were named only says that one ran out.
  const exhausted = spent.exhausted !== undefined || task.stats?.budget_exhausted === true;
  const body = task.result || draft;
  const unread = task.stats?.unread ?? [];
  return (
    <>
      {(task.status === "failed" || task.status === "canceled" || exhausted) && (
        <div className="flex flex-col gap-2 px-4 pt-4">
          {task.status === "failed" && <Notice tone="err">{task.error}</Notice>}
          {task.status === "canceled" && <Notice tone="warn">已停止，未生成报告</Notice>}
          {exhausted && task.status !== "canceled" && (
            <Notice tone="warn">{spent.exhausted ? `${limitLabel[spent.exhausted]}预算已用尽` : "预算已用尽"}，报告基于已收集的材料。</Notice>
          )}
        </div>
      )}
      {unread.length > 0 && (
        <div className="px-4 pt-4">
          <Notice tone="warn">
            报告引用了 {unread.length} 个 Agent 未读取过的链接，相关论断未经原文核对：
            <ul className="mt-1 flex flex-col gap-0.5">
              {unread.map((url) => (
                <li key={url} className="num text-xs break-all">
                  {url}
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      )}
      {!task.result && draft && (
        <div className="flex items-center gap-2 px-5 pt-4 text-xs text-ink-3">
          {live && <Dot tone="signal" live />}
          {live ? "草稿 · 输出中" : "未完成的草稿"}
        </div>
      )}
      {body ? (
        <article className="px-5 py-4">
          {rendered ? (
            <Markdown>{body}</Markdown>
          ) : (
            <CodeBlock copy wrap>
              {body}
            </CodeBlock>
          )}
        </article>
      ) : (
        live && <Empty title="检索完成后开始撰写" />
      )}
    </>
  );
}

/* ---------- Past runs ---------- */

/** The past runs, in a drawer the head of the page opens. A running one lights its button. */
function Tasks({
  tasks,
  pending,
  days,
  active,
  onPick,
  onReuse,
}: {
  tasks: ResearchTaskSummary[] | undefined;
  pending: boolean;
  /** How long tasks are kept. */
  days: number;
  active: string | null;
  onPick: (id: string) => void;
  onReuse: (task: ResearchTaskSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const list = tasks ?? [];
  const running = list.some((t) => t.status === "running");
  return (
    <>
      <Drawer
        trigger={<Button icon={running ? <Dot tone="signal" live /> : <History />}>历史</Button>}
        open={open}
        onOpenChange={setOpen}
        width="w-[min(30rem,100vw)]"
        bodyClassName=""
        title="最近的研究"
        description={`含经 MCP 发起的研究 · 保留 ${days} 天`}
      >
        {list.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-ink-3">{pending ? "正在读取…" : "暂无记录"}</div>
        ) : (
          <ol className="divide-y divide-line">
            {list.map((task) => {
              const meta = statusMeta[task.status];
              const spent = spentOf(task);
              const isCurrent = task.id === active;
              const tokens = spent.input_tokens + spent.output_tokens;
              const pick = () => {
                onPick(task.id);
                setOpen(false);
              };
              return (
                <li key={task.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-current={isCurrent ? "true" : undefined}
                    onClick={pick}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pick();
                      }
                    }}
                    className={cx("relative flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-fill", isCurrent && "bg-fill-strong")}
                  >
                    <Dot tone={meta.tone} live={task.status === "running"} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-sm text-ink">{task.question}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
                        <span className="text-ink-2">{meta.label}</span>
                        <span className="num">
                          {task.budget ? Math.min(spent.steps, task.budget.max_steps) : spent.steps} 步 · {compact(tokens)} tok
                        </span>
                        {task.status !== "running" && <span className="num">{duration(task.updated_at - task.created_at)}</span>}
                        <span>{ago(task.created_at)}</span>
                        {task.budget && (
                          <span className="num">
                            {task.budget.model} · {task.budget.reading === "raw" ? "原文" : "归纳"}
                          </span>
                        )}
                      </div>
                      {task.error && <div className="mt-0.5 truncate text-xs text-err">{task.error}</div>}
                      {task.status === "running" && task.progress && <div className="mt-0.5 truncate text-xs text-ink-3">{task.progress}</div>}
                    </div>
                    <Tooltip content="只载入课题与设置">
                      <button
                        type="button"
                        aria-label="载入设置"
                        onKeyDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onReuse(task);
                          setOpen(false);
                        }}
                        className="-mr-1.5 grid size-7 shrink-0 place-items-center rounded-ctl text-ink-3 transition-colors hover:bg-surface hover:text-ink"
                      >
                        <RotateCcw className="size-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Drawer>
    </>
  );
}
