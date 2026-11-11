import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { FlowView, TimelineView } from "../components/flow/FlowView";
import { LivePhase } from "../components/flow/LivePhase";
import { stoppedHere } from "../components/flow/wording";
import { ProviderNames } from "../components/ProviderName";
import { api, type LogEntry, type TraceNode, type TraceText } from "../lib/api";
import { clientName, dateTime, duration, percent, toolLabel } from "../lib/format";
import { useNow } from "../lib/motion";
import { attr, legacyTrace, useLiveCall } from "../lib/trace";
import { useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, CodeBlock, cx, Dot, Empty, Notice, Panel, Skeleton, Status, TabList, TabPanel, Tabs } from "../ui/primitives";

function pretty(json: string | undefined): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    // A captured body is cut at a size limit, which leaves invalid JSON.
    return json;
  }
}

function Fact({ label, children, className, wrap }: { label: string; children: ReactNode; className?: string; wrap?: boolean }) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="tag">{label}</div>
      <div className={cx("mt-1 text-sm text-ink", wrap ? "break-words" : "truncate")}>{children}</div>
    </div>
  );
}

type View = "flow" | "timeline" | "request" | "response";

/**
 * One call, whole: how it was decided and served as a flow, where its time
 * went, what it was asked and what it answered. `id` is the id of a log
 * entry, or of a call still in flight (`c_…`), which is followed as it runs
 * and becomes its log entry when it ends (`onWritten`).
 *
 * On a page of its own it has the way back to the list; in the panel of the
 * list it sits in a scroll box under a header of its own.
 */
export function CallInspector({
  id,
  onWritten,
  inPanel = false,
  lead,
  tools,
}: {
  id: string;
  onWritten: (logId: number) => void;
  inPanel?: boolean;
  /** Above the title, as the way back. */
  lead?: ReactNode;
  /** At the end of the header, after the call's own actions. */
  tools?: ReactNode;
}) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const inFlight = id.startsWith("c_");
  const live = useLiveCall(inFlight ? id : undefined);
  const over = inFlight && (!!live.done || live.gone);
  const running = inFlight && !over;

  // A call that ended has a log entry, written a moment after its last event.
  const written = useQuery({
    queryKey: ["log-by-call", id],
    queryFn: () => api.logByCall(id),
    enabled: over,
    retry: 8,
    retryDelay: 400,
  });
  const [streamedText, setStreamedText] = useState<{ id: number; from: string; text: TraceText } | null>(null);
  useEffect(() => {
    if (!written.data) return;
    client.setQueryData(["log", written.data.id], written.data);
    setStreamedText({ id: written.data.id, from: id, text: live.text });
    onWritten(written.data.id);
    // Only once per entry: the text of the call is what it was when it ended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [written.data]);

  const stored = useQuery({ queryKey: ["log", Number(id)], queryFn: () => api.log(Number(id)), enabled: !inFlight });
  const entry: LogEntry | undefined = stored.data;

  const nodes = useMemo<TraceNode[]>(() => (inFlight ? live.nodes : entry?.trace?.length ? entry.trace : entry ? legacyTrace(entry) : []), [inFlight, live.nodes, entry]);
  const traceText = inFlight ? live.text : streamedText?.id === entry?.id ? streamedText?.text : undefined;
  const legacy = !inFlight && !!entry && !entry.trace?.length;
  const root = nodes[0];

  const now = useNow(running, 200);
  const [view, setView] = useState<View>("flow");
  const [selected, setSelected] = useState(0);
  const [stopping, setStopping] = useState(false);
  // Another call has no such node; the entry a call became is the same call.
  const shown = useRef(id);
  useEffect(() => {
    if (shown.current !== id && !(streamedText?.from === shown.current && streamedText.id === Number(id))) setSelected(0);
    shown.current = id;
  }, [id, streamedText]);

  const stop = async () => {
    if (!(await confirm({ title: "中止这次调用？", body: "调用方将收到错误。", confirm: "中止", danger: true }))) return;
    setStopping(true);
    try {
      await api.cancelCall(id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setStopping(false);
    }
  };

  const missing = inFlight ? live.gone && written.isError : stored.isError;
  const loading = inFlight ? !live.call && !written.isError : stored.isPending;

  const tool = entry?.tool ?? live.call?.tool ?? root?.name ?? "";
  const summary = entry?.summary ?? live.call?.summary ?? "";
  // The log knows success and failure; that a call was stopped is said by its flow.
  const status = entry ? (root?.status === "canceled" ? "canceled" : entry.status) : live.done ? live.done.status : "running";
  const took = entry ? entry.duration_ms : live.done ? live.done.duration_ms : live.origin ? Math.max(0, now - live.origin) : 0;
  const source = entry?.source ?? live.call?.source;
  const keyName = entry?.api_key_name ?? live.call?.api_key_name;
  const ip = entry?.client_ip ?? live.call?.client_ip;
  const agent = entry?.user_agent ?? live.call?.user_agent;
  const taskId = entry?.task_id ?? live.call?.task_id;
  const said = entry?.error ?? live.done?.error;
  const error = said === stoppedHere ? "这次调用被从控制台中止。" : said;
  const request = entry?.request ? pretty(entry.request) : root && attr(root, "args") ? JSON.stringify(attr(root, "args"), null, 2) : "";
  // What the models of a running call have written so far, the latest last.
  const writing = Object.entries(live.text)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, text]) => text)
    .join("\n\n");

  const actions = (
    <div className="flex shrink-0 items-center gap-2">
      {taskId && !running && (
        <a
          href={`/report/${taskId}`}
          target="_blank"
          rel="noreferrer"
          className="press inline-flex h-8 items-center gap-1.5 rounded-ctl bg-fill px-3 text-sm text-ink hover:bg-fill-strong"
        >
          <ExternalLink className="size-3.5" />
          研究报告
        </a>
      )}
      {running && (
        <Button variant="danger" icon={<Square />} loading={stopping} onClick={stop}>
          中止
        </Button>
      )}
      {tools}
    </div>
  );

  const head = (
    <header className={inPanel ? "shrink-0 border-b border-line px-5 py-3.5" : "mb-5"}>
      {lead}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <Badge>{toolLabel[tool] ?? (tool || "调用")}</Badge>
            <h1 className={cx("num", inPanel ? "t-heading text-base" : "t-title")}>{entry ? `#${entry.id}` : inFlight ? "进行中的调用" : `#${id}`}</h1>
            <StatusBadge status={status} />
            <span className="num text-xs text-ink-3">{entry ? dateTime(entry.ts) : live.call ? dateTime(live.call.started_at) : ""}</span>
          </div>
          {summary && <p className={cx("line-clamp-2 text-sm break-words text-ink-2", inPanel ? "mt-1" : "mt-1.5")}>{summary}</p>}
        </div>
        {actions}
      </div>
    </header>
  );

  const body = missing ? (
        <Panel>
          <Empty title={inFlight ? "调用已结束，找不到它的记录" : "没有这条日志"} />
        </Panel>
      ) : loading ? (
        <div className="flex flex-col gap-4" role="status" aria-label="加载中">
          <Skeleton panel className="h-16" />
          <Skeleton panel className="h-[28rem]" />
        </div>
      ) : (
        <div className="@container flex flex-col gap-4">
          <div
            className={cx(
              "grid grid-cols-2 gap-x-5 gap-y-3 rounded-panel border border-line bg-surface px-4 py-3.5 @xl:grid-cols-4",
              entry && entry.input_tokens > 0
                ? "@5xl:grid-cols-[minmax(4.5rem,0.75fr)_minmax(12.5rem,1.85fr)_minmax(5rem,0.9fr)_minmax(5.5rem,0.9fr)_minmax(5.5rem,0.9fr)_minmax(7.5rem,1.1fr)_minmax(6rem,0.95fr)_minmax(4.5rem,0.75fr)]"
                : "@5xl:grid-cols-6",
            )}
          >
            <Fact label={running ? "已用时" : "总耗时"}>
              <span className="num">{duration(took)}</span>
            </Fact>
            <Fact
              label={running ? "正在" : "响应提供商"}
              wrap
              className={running ? "col-span-1 @xl:col-span-3 @5xl:col-span-2" : !(entry && entry.input_tokens > 0) ? "@5xl:col-span-2" : undefined}
            >
              {running ? live.call ? <LivePhase call={live.call} /> : "—" : entry?.provider ? <ProviderNames ids={entry.provider} kind={entry.tool === "research" ? "llm" : undefined} /> : "—"}
            </Fact>
            <Fact label="调用方">{source === "webui" ? "调试台" : keyName || "—"}</Fact>
            <Fact label="来源 IP">
              <span className="num">{ip || "—"}</span>
            </Fact>
            <Fact label="客户端">
              <span className="num" title={agent}>
                {clientName(agent) || "—"}
              </span>
            </Fact>
            {entry && entry.input_tokens > 0 && (
              <>
                <Fact label="Token 输入 / 输出">
                  <span className="num">
                    {entry.input_tokens.toLocaleString()} / {entry.output_tokens.toLocaleString()}
                  </span>
                </Fact>
                <Fact label="缓存 读 / 写">
                  <span className="num">
                    {(entry.cache_read_tokens ?? 0).toLocaleString()} / {(entry.cache_write_tokens ?? 0).toLocaleString()}
                  </span>
                </Fact>
                <Fact label="缓存命中率">
                  <span className="num">{percent(entry.cache_read_tokens ?? 0, entry.input_tokens)}</span>
                </Fact>
              </>
            )}
          </div>

          {error && status !== "running" && (
            <Notice tone={status === "canceled" ? "neutral" : "err"}>
              <span className={cx("break-words", said !== stoppedHere && "num")}>{error}</span>
            </Notice>
          )}

          <Panel flush className="overflow-hidden">
            <Tabs value={view} onChange={setView}>
              <TabList
                tabs={[
                  {
                    value: "flow",
                    label: (
                      <>
                        流程
                        {running && <Dot tone="signal" live />}
                      </>
                    ),
                  },
                  { value: "timeline", label: "时间轴" },
                  { value: "request", label: "请求" },
                  { value: "response", label: "返回" },
                ]}
              />
              <TabPanel value="flow">
                {legacy && (
                  <div className="border-b border-line px-4 py-2 text-xs text-ink-3">旧版记录，只有上游请求，没有判断过程</div>
                )}
                {nodes.length > 0 ? (
                  <FlowView
                    nodes={nodes}
                    text={traceText}
                    live={running}
                    origin={live.origin}
                    selected={selected}
                    onSelect={setSelected}
                    className="min-h-[28rem]"
                  />
                ) : (
                  <Empty title="还没有收到这次调用的任何一步" />
                )}
              </TabPanel>
              <TabPanel value="timeline">
                {nodes.length > 0 ? (
                  <TimelineView
                    nodes={nodes}
                    text={traceText}
                    live={running}
                    origin={live.origin}
                    selected={selected}
                    onSelect={setSelected}
                  />
                ) : (
                  <Empty title="还没有收到这次调用的任何一步" />
                )}
              </TabPanel>
              <TabPanel value="request" className="flex flex-col gap-4 p-4">
                <section>
                  <h3 className="tag mb-1.5">请求参数</h3>
                  {request ? <CodeBlock copy>{request}</CodeBlock> : <div className="text-xs text-ink-3">没有记录。</div>}
                </section>
                {agent && (
                  <section>
                    <h3 className="tag mb-1.5">User-Agent</h3>
                    <CodeBlock wrap copy>
                      {agent}
                    </CodeBlock>
                  </section>
                )}
              </TabPanel>
              <TabPanel value="response" className="p-4">
                {entry?.response ? (
                  <CodeBlock copy wrap className="max-h-[70dvh]">
                    {pretty(entry.response)}
                  </CodeBlock>
                ) : running ? (
                  writing ? (
                    <CodeBlock wrap className="max-h-[70dvh]">
                      {writing}
                    </CodeBlock>
                  ) : (
                    <div className="text-xs text-ink-3">调用结束后显示。</div>
                  )
                ) : (
                  <div className="text-xs text-ink-3">
                    未记录 ·{" "}
                    <Link href="/system" className="text-ink-2 underline underline-offset-2 hover:text-ink">
                      开启记录
                    </Link>
                  </div>
                )}
              </TabPanel>
            </Tabs>
          </Panel>
        </div>
      );

  if (!inPanel) {
    return (
      <>
        {head}
        {body}
      </>
    );
  }
  return (
    <>
      {head}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">{body}</div>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  return status === "running" ? (
    <Status tone="signal" live>
      进行中
    </Status>
  ) : status === "ok" ? (
    <Status tone="ok">成功</Status>
  ) : status === "canceled" ? (
    <Status>已中止</Status>
  ) : (
    <Badge tone="err" dot>
      失败
    </Badge>
  );
}

/** A call on a page of its own, which a link or the panel of the list opens. */
export function LogPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const back = () => {
    // Back to the list as it was left, filters and all, when that is where this page was opened from.
    if ((window.history.state as { from?: string } | null)?.from === "logs") window.history.back();
    else navigate("/logs");
  };
  return (
    <CallInspector
      id={id}
      onWritten={(logId) => navigate(`/logs/${logId}`, { replace: true, state: window.history.state })}
      lead={
        <button type="button" onClick={back} className="mb-2 inline-flex items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink">
          <ArrowLeft className="size-3.5" />
          请求日志
        </button>
      }
    />
  );
}
