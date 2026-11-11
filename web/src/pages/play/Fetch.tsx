import { Bot, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { allModels, hasOtherModels, ModelOverride } from "../../components/ModelPicker";
import { ProviderNames } from "../../components/ProviderName";
import { api, type FetchArgs, type FetchResult } from "../../lib/api";
import { useConfig } from "../../lib/config";
import { compact, duration } from "../../lib/format";
import { useElapsed } from "../../lib/motion";
import { usePlay } from "../../lib/trace";
import { Markdown } from "../../ui/markdown";
import { Popover } from "../../ui/overlays";
import { Badge, Button, CodeBlock, Notice, NumberInput, Segmented, Switch } from "../../ui/primitives";
import {
  Chip,
  CodeButton,
  Composer,
  Examples,
  Failure,
  Group,
  HistoricalFallback,
  HistoryBanner,
  type InspectedRun,
  JSONView,
  latestText,
  LocalNotice,
  LocalTag,
  onModEnter,
  OptionGroup,
  Output,
  ProviderChip,
  ProviderParams,
  Recent,
  ResultError,
  RunButton,
  Stage,
  Summary,
  useRunView,
  useTuning,
  Waiting,
  Writing,
} from "./kit";

type Sent = Parameters<typeof api.playFetch>[0];

/** What was typed as an address, with the scheme people leave out. */
const address = (text: string) => {
  const url = text.trim();
  return url === "" || /^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`;
};

const defaultExamplePrompt = "概括这篇文档的核心内容与关键技术要点";

export function FetchPlay() {
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
  const [noCache, setNoCache] = useState(false);
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<"rendered" | "text" | "json">("rendered");
  const [inspected, setInspected] = useState<InspectedRun<FetchResult> | null>(null);
  const tuning = useTuning("fetch", engine);
  const run = usePlay(api.playFetch);
  const views = useRunView(run.pending);
  const elapsed = useElapsed(run.pending);

  const extract = answer && canExtract;
  const args: FetchArgs = { url: address(url), prompt: extract ? prompt.trim() : "" };
  if (!extract) args.raw = true;
  if (!extract && offset > 0) args.offset = offset;
  if (engine !== "auto") args.fetch_engine = engine;

  // An assigned model answers by itself; with no chain, the one tried is the first.
  const override = extract ? model || (chain.length === 0 ? models[0]?.id : undefined) : undefined;

  const ready = args.url !== "" && (!extract || args.prompt !== "");
  const send = (next: Sent) => {
    setInspected(null);
    views.begin();
    run.start(next);
  };
  const submit = () => ready && !run.pending && send({ ...args, model: override, no_cache: noCache || undefined, route: tuning.route });
  // An offset belongs to one page.
  const changeUrl = (next: string) => {
    setUrl(next);
    setOffset(0);
  };

  const restore = (request: Record<string, unknown>) => {
    const pinned = typeof request.fetch_engine === "string" ? request.fetch_engine : "auto";
    changeUrl(typeof request.url === "string" ? request.url : "");
    setPrompt(typeof request.prompt === "string" ? request.prompt : "");
    setAnswer(request.raw !== true && canExtract);
    setOffset(typeof request.offset === "number" ? request.offset : 0);
    setEngine(config.fetch.routes.some((r) => r.enabled && r.provider === pinned) ? pinned : "auto");
  };

  const rerun = () => {
    if (run.pending) return;
    if (inspected?.request) {
      const req = inspected.request;
      restore(req);
      const pinned = typeof req.fetch_engine === "string" ? req.fetch_engine : "auto";
      const nextEngine = config.fetch.routes.some((r) => r.enabled && r.provider === pinned) ? pinned : "auto";
      const nextUrl = address(typeof req.url === "string" ? req.url : "");
      const nextExtract = req.raw !== true && canExtract;
      const nextPrompt = nextExtract && typeof req.prompt === "string" ? req.prompt.trim() : "";
      const nextOffset = !nextExtract && typeof req.offset === "number" ? req.offset : 0;
      if (!nextUrl || (nextExtract && !nextPrompt)) return;
      const nextArgs: FetchArgs = { url: nextUrl, prompt: nextPrompt };
      if (!nextExtract) nextArgs.raw = true;
      if (nextOffset > 0) nextArgs.offset = nextOffset;
      if (nextEngine !== "auto") nextArgs.fetch_engine = nextEngine;
      send({ ...nextArgs, model: nextExtract ? model || (chain.length === 0 ? models[0]?.id : undefined) : undefined, no_cache: noCache || undefined });
      return;
    }
    submit();
  };

  const data = run.data;
  const activeResult = inspected ? inspected.response : data?.result;
  const activeDuration = inspected ? inspected.entry.duration_ms : (data?.duration_ms ?? 0);
  const activeEngine = inspected ? inspected.entry.provider : data?.result.fetch_engine;
  const cached = inspected
    ? (inspected.entry.trace?.some((n) => n.kind === "cache" && n.status === "cached") ?? false) || (inspected.entry.attempts?.some((a) => a.status === "cached") ?? false)
    : run.nodes.some((n) => n.kind === "cache" && n.status === "cached");
  // The answer as its model writes it.
  const writing = run.pending ? latestText(run.text) : "";
  // Tuned parameters bypass the cache by themselves.
  const fresh = noCache || tuning.changed;

  return (
    <Stage
      tool="fetch"
      title="网页抓取"
      history={
        <Recent<FetchResult>
          tool="fetch"
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
            activeResult && (
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
            (inspected || data) && (
              <>
                <span className="num font-medium text-ink">{duration(activeDuration)}</span>
                {activeEngine && <ProviderNames ids={activeEngine} />}
                {cached && <Badge tone="info">缓存命中</Badge>}
                {!inspected && run.variables?.model && <Badge>{run.variables.model}</Badge>}
                {!inspected && run.variables?.route && <Badge>临时参数</Badge>}
                {activeResult && <span>{activeResult.answer !== undefined ? "提取回答" : "原文"}</span>}
                {activeResult && textLength(activeResult) !== undefined && <span className="num">全文 {compact(textLength(activeResult)!)} 字节</span>}
              </>
            )
          }
        >
          {!inspected && run.pending ? (
            writing ? (
              <Writing text={writing} />
            ) : (
              <Waiting label={run.variables?.url} elapsed={elapsed} />
            )
          ) : !inspected && run.error ? (
            <Failure error={run.error} />
          ) : inspected && !inspected.response ? (
            <HistoricalFallback entry={inspected.entry} request={inspected.request} onRerun={rerun} />
          ) : activeResult && format === "json" ? (
            <JSONView value={activeResult} />
          ) : (
            activeResult && (
              <FetchResultView
                result={activeResult}
                from={inspected ? (typeof inspected.request?.offset === "number" ? inspected.request.offset : 0) : (run.variables?.offset ?? 0)}
                rendered={format === "rendered"}
                onNext={(next) => {
                  const targetUrl = inspected ? (typeof inspected.request?.url === "string" ? inspected.request.url : url) : (run.variables?.url ?? url);
                  const targetEngine = inspected
                    ? typeof inspected.request?.fetch_engine === "string"
                      ? inspected.request.fetch_engine
                      : undefined
                    : run.variables?.fetch_engine;
                  if (!targetUrl) return;
                  setUrl(targetUrl);
                  setEngine(targetEngine ?? "auto");
                  setAnswer(false);
                  setOffset(next);
                  send({ url: targetUrl, prompt: "", raw: true, offset: next, fetch_engine: targetEngine, no_cache: noCache || undefined, route: tuning.route });
                }}
              />
            )
          )}
        </Output>
      }
    >
      <Composer
        open={open}
        tools={
          <>
            {canExtract && (
              <Segmented
                size="sm"
                value={extract ? "answer" : "raw"}
                onChange={(v) => setAnswer(v === "answer")}
                options={[
                  { value: "answer", label: "提取回答" },
                  { value: "raw", label: "原文" },
                ]}
              />
            )}
            <ProviderChip tool="fetch" value={engine} onChange={setEngine} changed={tuning.changed} />
            {extract &&
              (hasOtherModels(config, chain) ? (
                <Popover className="w-84 p-2" trigger={<Chip icon={<Bot />} label="模型" value={<span className="num">{override ?? chain[0]}</span>} changed={model !== ""} />}>
                  <ModelOverride assigned={chain} value={model} onChange={setModel} />
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-2 pb-0.5 text-xs text-ink-3">
                    <LocalTag />
                    使用所选模型提取，不触发故障转移
                  </p>
                </Popover>
              ) : (
                (override ?? chain[0]) && (
                  <span className="inline-flex h-7 items-center gap-1.5 rounded-ctl border border-line bg-surface px-2.5 text-xs text-ink-3">
                    <Bot className="size-3.5" />
                    <span className="num text-ink-2">{override ?? chain[0]}</span>
                  </span>
                )
              ))}
            {!extract && (
              <div className="flex items-center gap-1.5 text-xs text-ink-3">
                <span>偏移</span>
                <NumberInput
                  className="w-28"
                  min={0}
                  suffix="字节"
                  value={offset}
                  aria-label="起始位置"
                  onChange={(v) => setOffset(Math.round(v))}
                />
              </div>
            )}
          </>
        }
        toolbarRight={
          <>
            {fresh && <Summary onClick={() => setOpen(true)}>不读写缓存</Summary>}
            <Chip
              icon={<SlidersHorizontal />}
              label="缓存与参数"
              changed={noCache || tuning.changed}
              aria-expanded={open}
              aria-pressed={open}
              onClick={() => setOpen(!open)}
            />
            <CodeButton
              tool="fetch"
              args={args}
              notices={<LocalNotice items={[override && `提取模型 ${override}`, noCache && "绕过缓存", tuning.changed && `${provider(engine).name} 的临时参数`]} />}
            />
          </>
        }
        panel={
          <>
            <OptionGroup title="调用参数">
              {!canExtract && (
                <Notice tone="warn">
                  尚无模型，只能返回原文。
                  <Link href="/models" className="text-ink underline underline-offset-2">
                    去添加
                  </Link>
                </Notice>
              )}
              {canExtract && chain.length === 0 && <Notice tone="info">未配置提取模型，这里可临时试用。</Notice>}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <Group
                  label="绕过缓存"
                  local
                  hint={tuning.changed ? "临时参数下始终绕过" : undefined}
                >
                  <Switch checked={fresh} disabled={tuning.changed} onCheckedChange={setNoCache} aria-label="绕过缓存" />
                </Group>
              </div>
            </OptionGroup>
            <ProviderParams tool="fetch" engine={engine} tuning={tuning} />
          </>
        }
        footer={
          <Examples
            items={["https://modelcontextprotocol.io/specification/draft/basic/transports", "https://go.dev/doc/devel/release"]}
            current={url}
            onPick={(picked) => {
              changeUrl(picked);
              if (extract && prompt.trim() === "") setPrompt(defaultExamplePrompt);
            }}
            onClear={() => {
              changeUrl("");
              setPrompt("");
            }}
          />
        }
        actions={<RunButton label="抓取" loading={run.pending} disabled={!ready} onClick={submit} onStop={run.stop} />}
      >
        <div className="flex items-center border-b border-line px-3.5">
          <span className="tag w-12 shrink-0 text-ink-3">URL</span>
          <input
            value={url}
            spellCheck={false}
            autoComplete="off"
            aria-label="URL"
            placeholder="https://example.com/article"
            className="num h-11 min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-3 focus:outline-none"
            onChange={(e) => changeUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
        {extract ? (
          <div className="flex items-start px-3.5 py-2.5">
            <span className="tag w-12 shrink-0 pt-1 text-ink-3">问题</span>
            <textarea
              rows={2}
              value={prompt}
              aria-label="针对页面的问题"
              placeholder="想从这个页面知道什么？例如：这个版本有哪些破坏性变更"
              className="min-w-0 flex-1 resize-none bg-transparent text-sm leading-6 text-ink placeholder:text-ink-3 focus:outline-none"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onModEnter(submit)}
            />
          </div>
        ) : (
          <div className="flex items-center gap-3 px-3.5 py-2.5 text-xs text-ink-3">
            <span className="tag w-12 shrink-0">模式</span>
            <span>返回 Markdown 原文，长页面分段</span>
          </div>
        )}
      </Composer>
    </Stage>
  );
}

// A request log from before the rename still says content_length.
function textLength(result: FetchResult) {
  return result.text_length ?? result.content_length;
}

function FetchResultView({ result, from, rendered, onNext }: { result: FetchResult; from: number; rendered: boolean; onNext: (offset: number) => void }) {
  const body = result.answer ?? result.text ?? result.content ?? "";
  const total = textLength(result) ?? 0;
  const [start, end] = result.covered ?? [from, result.next_offset || total];
  const more = result.next_offset !== undefined && result.next_offset > 0;
  return (
    <>
      {(result.error || result.warning || result.answer_truncated) && (
        <div className="flex flex-col gap-2 px-4 pt-4">
          {result.error && <ResultError error={result.error} />}
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
