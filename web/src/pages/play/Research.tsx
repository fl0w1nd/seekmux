import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Braces, FileText, Flag, MessageSquareText, RotateCcw, Search, SlidersHorizontal, Square, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
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
import { Markdown } from "../../ui/markdown";
import { Popover, useConfirm, useToast } from "../../ui/overlays";
import { Badge, Button, CodeBlock, CopyButton, cx, Dot, Empty, Notice, NumberInput, Segmented, Spinner, TabList, Tabs, Tooltip, type Tone } from "../../ui/primitives";
import { bare, Chip, CodeButton, Composer, Examples, Group, host, LocalNotice, LocalTag, onModEnter, OptionGroup, ResetButton, RunButton, Stage, Summary, TabPanel } from "./kit";

/** Where the task on show is remembered, so a reload returns to it. */
const taskKey = "seekmux-play-research-task";

type LimitKey = "max_steps" | "max_duration_seconds" | "max_tokens" | "max_context_tokens";

// What a run may be given; the ceilings match the server's (app.maxResearchSteps, app.maxResearchDuration).
const limits: { key: LimitKey; label: string; suffix: string; min: number; max: number; hint: string }[] = [
  { key: "max_steps", label: "最大步数", suffix: "步", min: 1, max: 200, hint: "一步为模型的一轮推理，可并行发起多次搜索和抓取" },
  { key: "max_duration_seconds", label: "最长用时", suffix: "秒", min: 30, max: 3600, hint: "达到 80% 时开始收尾并撰写报告" },
  { key: "max_tokens", label: "Token 上限", suffix: "token", min: 1000, max: 1e9, hint: "各步输入与输出的累计值，约束总花费" },
  { key: "max_context_tokens", label: "上下文上限", suffix: "token", min: 1000, max: 1e9, hint: "单次请求的输入规模，应低于模型的上下文窗口" },
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
  // A task that is gone, pruned after a week, is nothing to return to.
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
    if (!(await confirm({ title: "停止这次研究？", body: "已消耗的额度不会退回，也不会生成报告；已写出的草稿会保留。", confirm: "停止", danger: true }))) return;
    try {
      await api.cancelResearch(data.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "err");
    }
    void task.refetch();
  };
  /** Takes the question and the settings of a past run back into the composer. */
  const reuse = (from: ResearchTask) => {
    setQuestion(from.question);
    const b = from.budget;
    if (!b) return;
    setModel(b.model !== saved.model && config.llm.providers.some((p) => p.models.some((m) => m.id === b.model)) ? b.model : "");
    const next: BudgetOverride = {};
    for (const { key } of limits) if (b[key] !== saved[key]) next[key] = b[key];
    if (b.reading !== saved.reading) next.reading = b.reading;
    setOverride(next);
    if (Object.keys(next).length > 0) setOpen(true);
  };

  return (
    <>
      <Stage title="发起研究" description="调用 research 工具：研究 Agent 用本网关的搜索与抓取反复查证，最后写出附带出处的报告。预算在运行中实时跟踪，可只为这一次调整。">
        {!saved.enabled && (
          <Notice tone="warn" className="mb-3">
            深度研究尚未启用。请前往{" "}
            <Link href="/research" className="text-ink underline underline-offset-2">
              深度研究
            </Link>{" "}
            页选择模型并启用。
          </Notice>
        )}
        <Composer
          open={open}
          tools={
            <>
              <Chip icon={<SlidersHorizontal />} label="预算" aria-pressed={open} changed={changed > 0} onClick={() => setOpen(!open)} />
              {saved.enabled && hasOtherModels(config, assigned) && (
                <Popover className="w-84 p-2" trigger={<Chip icon={<Bot />} value={<span className="num">{model || saved.model}</span>} changed={model !== ""} />}>
                  <ModelOverride assigned={assigned} value={model} onChange={setModel} />
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-2 pb-0.5 text-xs text-ink-3">
                    <LocalTag />
                    研究全程只用这一个模型，不做故障转移。
                  </p>
                </Popover>
              )}
              <Summary onClick={() => setOpen(true)}>{budgetText(budget)}</Summary>
            </>
          }
          actions={
            <>
              <CodeButton
                tool="research"
                args={{ question: question.trim() }}
                notices={<LocalNotice items={[model && `模型 ${model}`, changed > 0 && `临时预算（${budgetText(budget)}${override.reading ? `，${override.reading === "raw" ? "读原文" : "读归纳"}` : ""}）`]} />}
              />
              {/* One run at a time here; it is stopped from its own header. */}
              <RunButton label={running ? "研究中" : "开始研究"} loading={start.isPending || running} disabled={!ready || running} onClick={submit} />
            </>
          }
          panel={
            <>
              <OptionGroup title="本次预算" local action={changed > 0 && <ResetButton onClick={() => setOverride({})} />}>
                <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                  {limits.map((limit) => {
                    const base = saved[limit.key];
                    return (
                      <Group key={limit.key} label={limit.label} hint={limit.hint}>
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
                <p className="text-xs text-ink-3">任一项耗尽时，Agent 停止检索并基于现有材料撰写报告。</p>
              </OptionGroup>
              <OptionGroup title="阅读方式" local>
                <Segmented
                  stretch
                  size="sm"
                  value={budget.reading}
                  onChange={(reading: Research["reading"]) => set("reading", reading)}
                  options={[
                    { value: "raw", label: "原文" },
                    { value: "extract", label: "归纳" },
                  ]}
                />
                <p className="text-xs text-ink-3">
                  {budget.reading === "raw"
                    ? "研究模型直接读取网页原文，长页面分段读取。最接近一手材料，占用的上下文也最多。"
                    : config.fetch.extract.models.length > 0
                      ? "由提取模型先按研究模型的提问归纳各网页，将答案交给研究模型；需要代码或原话时，研究模型仍可按页读取原文。节省上下文，准确度取决于提取模型。"
                      : "尚未配置提取模型，网页仍按原文返回。"}
                </p>
                <p className="mt-auto text-xs text-ink-3">
                  初始值取自{" "}
                  <Link href="/research" className="text-ink-2 underline underline-offset-2 hover:text-ink">
                    深度研究页
                  </Link>{" "}
                  的配置。这里的改动只随下一次运行发出，不保存，MCP 调用始终按配置运行。
                </p>
              </OptionGroup>
            </>
          }
        >
          <textarea
            rows={3}
            value={question}
            aria-label="研究问题"
            disabled={!saved.enabled}
            placeholder="写下需要多方查证的问题，并说明背景、约束和想要的答案形式"
            className={cx(bare, "resize-none pt-3.5 pb-2 leading-6")}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onModEnter(submit)}
          />
        </Composer>
        {start.error && (
          <Notice tone="err" className="mt-3">
            {start.error.message}
          </Notice>
        )}
        {question.trim() === "" && saved.enabled && <Examples mono={false} items={["对比 Brave、Exa、Tavily 搜索 API 的定价与限流", "SQLite WAL 模式在高并发写入下的取舍"]} onPick={setQuestion} />}
      </Stage>

      {taskId !== null &&
        !gone &&
        (data ? (
          // The clock of the server, so a run is timed the same wherever the console is opened.
          <Run key={data.id} task={data} skew={data.now - task.dataUpdatedAt} onStop={() => void stop()} onReuse={() => reuse(data)} onClose={() => show(null)} />
        ) : (
          <section className="mt-6 grid place-items-center rounded-panel border border-line bg-surface py-20">
            {task.error ? <Notice tone="err">{task.error.message}</Notice> : <Spinner />}
          </section>
        ))}

      <Tasks tasks={tasks.data} pending={tasks.isPending} active={taskId} onPick={show} />
    </>
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

  const [view, setView] = useState<"process" | "report">(live || !(task.result || task.draft) ? "process" : "report");
  const [format, setFormat] = useState<"rendered" | "text">("rendered");
  // The report is what a finished run is opened for.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live && (task.result || task.draft)) setView("report");
    wasLive.current = live;
  }, [live]);
  // A run that has just been started is brought into view; one reopened is where the click was.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (wasLive.current && task.steps.length === 0) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const phase = !live
    ? null
    : spent.exhausted
      ? `${limitLabel[spent.exhausted]}预算用尽，正在撰写报告`
      : task.draft
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

  return (
    <section ref={ref} className="mt-6 min-w-0 scroll-mt-6 rounded-panel border border-line bg-surface">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1 basis-72">
          <div className="flex items-center gap-2 text-xs">
            <span className={cx("flex items-center gap-1.5 font-medium", live ? "text-signal-text" : "text-ink-2")}>
              <Dot tone={meta.tone} live={live} />
              {meta.label}
            </span>
            {phase && <span className="min-w-0 truncate text-ink-3">{phase}</span>}
          </div>
          <h2 className="mt-1 line-clamp-2 text-base font-medium" title={task.question}>
            {task.question}
          </h2>
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

      <Tabs value={view} onChange={setView}>
        <TabList
          tabs={[
            {
              value: "process",
              label: (
                <>
                  过程{rows.length > 0 && <span className="num text-xs text-ink-3">{rows.length}</span>}
                </>
              ),
            },
            {
              value: "report",
              label: (
                <>
                  报告{live && task.draft && <Dot tone="signal" live />}
                </>
              ),
            },
          ]}
          actions={
            view === "report" &&
            task.result && (
              <>
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
            )
          }
        />
        <TabPanel value="process">
          <Timeline rows={rows} live={live} phase={phase} elapsed={elapsed} />
        </TabPanel>
        <TabPanel value="report">
          <Report task={task} spent={spent} rendered={format === "rendered"} />
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
    <div className="grid grid-cols-2 gap-px border-b border-line bg-line lg:grid-cols-4">
      <Gauge
        label="步数"
        value={steps}
        limit={budget?.max_steps}
        live={live}
        spent={spent.exhausted === "steps"}
        cells={budget && budget.max_steps <= 48 ? budget.max_steps : undefined}
        foot={!budget ? "模型推理的轮数" : spent.exhausted && live ? "已停止检索，撰写报告" : live ? `还可再走 ${budget.max_steps - steps} 步` : `上限 ${budget.max_steps} 步`}
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
        foot={!maxMs ? "自开始以来" : live && elapsed < wrapUp ? `${stopwatch(wrapUp)} 起收尾` : live ? "已过收尾线" : `${stopwatch(wrapUp)} 为收尾线`}
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
            {cached > 0 && ` · 缓存读 ${percent(cached, spent.input_tokens)}`}
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
                "flex-1 rounded-[1px] transition-colors duration-500 ease-settle",
                i < value ? fill : "bg-sunken",
                // The step under way.
                live && !spent && i === value - 1 && "animate-pulse-dot",
              )}
            />
          ))}
        </div>
      ) : (
        <div className="relative h-1.5 rounded-full bg-sunken" role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemax={limit}>
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

/* ---------- Process ---------- */

const rowIcon = { search: Search, dev_search: Braces, fetch: FileText, note: MessageSquareText, wrap_up: Flag, line: FileText };

function Timeline({ rows, live, phase, elapsed }: { rows: Row[]; live: boolean; phase: string | null; elapsed: number }) {
  // The list follows its newest row while the reader stays at its end.
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && live && pinned.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, live, phase]);

  if (rows.length === 0 && !live) return <Empty title="这次运行没有留下步骤">Agent 未调用任何工具，或运行在第一步之前就已结束。</Empty>;

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
              {group.step !== undefined && <div className="num text-sm text-signal-text">{String(group.step).padStart(2, "0")}</div>}
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
            <span key={i} className="num max-w-full truncate rounded-[3px] border border-line bg-sunken px-1.5 py-px text-xs text-ink">
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

function Report({ task, spent, rendered }: { task: ResearchTask; spent: ResearchSpent; rendered: boolean }) {
  const live = task.status === "running";
  // A run recorded before limits were named only says that one ran out.
  const exhausted = spent.exhausted !== undefined || task.stats?.budget_exhausted === true;
  const body = task.result || task.draft || "";
  const unread = task.stats?.unread ?? [];
  return (
    <>
      {(task.status === "failed" || task.status === "canceled" || exhausted) && (
        <div className="flex flex-col gap-2 px-4 pt-4">
          {task.status === "failed" && <Notice tone="err">{task.error}</Notice>}
          {task.status === "canceled" && <Notice tone="warn">这次研究已被停止，没有生成报告。</Notice>}
          {exhausted && task.status !== "canceled" && (
            <Notice tone="warn">{spent.exhausted ? `${limitLabel[spent.exhausted]}预算已用尽` : "预算已用尽"}，Agent 停止检索并基于现有材料撰写报告。</Notice>
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
      {!task.result && task.draft && (
        <div className="flex items-center gap-2 px-5 pt-4 text-xs text-ink-3">
          {live && <Dot tone="signal" live />}
          {live ? "草稿 · 模型正在输出；若这一步接着调用工具，这段文字只是它的中间说明" : "未完成的草稿"}
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
        live && <Empty title="报告尚未开始">Agent 完成检索后在此撰写报告，文字会随输出逐步出现。</Empty>
      )}
    </>
  );
}

/* ---------- Past runs ---------- */

function Tasks({ tasks, pending, active, onPick }: { tasks: ResearchTaskSummary[] | undefined; pending: boolean; active: string | null; onPick: (id: string) => void }) {
  const list = tasks ?? [];
  return (
    <section className="mt-6">
      <header className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="tag">最近的研究</h2>
        <span className="text-xs text-ink-3">保留 7 天，含经 MCP 发起的任务</span>
      </header>
      <div className="rounded-panel border border-line bg-surface">
        {list.length === 0 ? (
          <Empty title={pending ? "正在读取…" : "还没有研究任务"}>{!pending && "从上方发起一次研究后，任务会出现在这里；点击可回看它的过程与报告。"}</Empty>
        ) : (
          <ol>
            {list.map((task) => {
              const meta = statusMeta[task.status];
              const spent = spentOf(task);
              return (
                <li key={task.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    aria-current={task.id === active}
                    onClick={() => onPick(task.id)}
                    className="flex min-h-10 w-full items-center gap-3 px-4 py-1.5 text-left transition-colors hover:bg-raised/60 aria-[current=true]:bg-raised"
                  >
                    <span className="flex w-16 shrink-0 items-center gap-1.5 text-xs text-ink-2">
                      <Dot tone={meta.tone} live={task.status === "running"} />
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{task.question}</span>
                    {task.budget && <Badge className="max-lg:hidden">{task.budget.model}</Badge>}
                    <span className="num w-32 shrink-0 text-right text-xs text-ink-3 max-sm:hidden">
                      {task.budget ? Math.min(spent.steps, task.budget.max_steps) : spent.steps} 步 · {compact(spent.input_tokens + spent.output_tokens)} token
                    </span>
                    <span className="num w-14 shrink-0 text-right text-xs text-ink-2">{task.status === "running" ? "—" : duration(task.updated_at - task.created_at)}</span>
                    <span className="w-16 shrink-0 text-right text-xs text-ink-3">{ago(task.created_at)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
