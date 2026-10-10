import { useMutation } from "@tanstack/react-query";
import { Bot, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { allModels, hasOtherModels, ModelOverride } from "../../components/ModelPicker";
import { api, type FetchArgs, type FetchResult } from "../../lib/api";
import { useConfig } from "../../lib/config";
import { compact, duration } from "../../lib/format";
import { useElapsed } from "../../lib/motion";
import { Markdown } from "../../ui/markdown";
import { Popover } from "../../ui/overlays";
import { Badge, Button, CodeBlock, cx, Notice, NumberInput, Segmented, Switch } from "../../ui/primitives";
import {
  bare,
  Chip,
  CodeButton,
  Composer,
  Examples,
  Failure,
  Group,
  JSONView,
  LocalNotice,
  LocalTag,
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
} from "./kit";

type Sent = Parameters<typeof api.playFetch>[0];

/** What was typed as an address, with the scheme people leave out. */
const address = (text: string) => {
  const url = text.trim();
  return url === "" || /^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`;
};

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
  const [view, setView] = useState<"result" | "trace">("result");
  const [format, setFormat] = useState<"rendered" | "text" | "json">("rendered");
  const tuning = useTuning("fetch", engine);
  const run = useMutation({ mutationFn: api.playFetch });
  const elapsed = useElapsed(run.isPending);

  const extract = answer && canExtract;
  const args: FetchArgs = { url: address(url), prompt: extract ? prompt.trim() : "" };
  if (!extract) args.raw = true;
  if (!extract && offset > 0) args.offset = offset;
  if (engine !== "auto") args.fetch_engine = engine;

  // An assigned model answers by itself; with no chain, the one tried is the first.
  const override = extract ? model || (chain.length === 0 ? models[0]?.id : undefined) : undefined;

  const ready = args.url !== "" && (!extract || args.prompt !== "");
  const send = (next: Sent) => {
    setView("result");
    run.mutate(next);
  };
  const submit = () => ready && !run.isPending && send({ ...args, model: override, no_cache: noCache || undefined, route: tuning.route });
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

  const data = run.data;
  const cached = data?.attempts?.some((a) => a.status === "cached");
  // Tuned parameters bypass the cache by themselves.
  const fresh = noCache || tuning.changed;

  return (
    <>
      <Stage title="抓取页面" description="调用 fetch 工具：读取一个页面，由提取模型按问题作答，或直接返回原文。调用记入请求日志。">
        <Composer
          open={open}
          tools={
            <>
              <Chip icon={<SlidersHorizontal />} label="参数" aria-pressed={open} onClick={() => setOpen(!open)} />
              <ProviderChip tool="fetch" value={engine} onChange={setEngine} changed={tuning.changed} />
              {canExtract && (
                <Segmented
                  value={extract ? "answer" : "raw"}
                  onChange={(v) => setAnswer(v === "answer")}
                  options={[
                    { value: "answer", label: "提取回答" },
                    { value: "raw", label: "原文" },
                  ]}
                />
              )}
              {extract && hasOtherModels(config, chain) && (
                <Popover className="w-84 p-2" trigger={<Chip icon={<Bot />} value={<span className="num">{override ?? chain[0]}</span>} changed={model !== ""} />}>
                  <ModelOverride assigned={chain} value={model} onChange={setModel} />
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-2 pb-0.5 text-xs text-ink-3">
                    <LocalTag />
                    所选模型单独作答，失败时不切换备用模型。
                  </p>
                </Popover>
              )}
              {(fresh || (!extract && offset > 0)) && (
                <Summary onClick={() => setOpen(true)}>{[!extract && offset > 0 && `从 ${compact(offset)} 字节起`, fresh && "不读写缓存"].filter(Boolean).join(" · ")}</Summary>
              )}
            </>
          }
          actions={
            <>
              <CodeButton
                tool="fetch"
                args={args}
                notices={<LocalNotice items={[override && `提取模型 ${override}`, noCache && "绕过缓存", tuning.changed && `${provider(engine).name} 的临时参数`]} />}
              />
              <RunButton label="抓取" loading={run.isPending} disabled={!ready} onClick={submit} />
            </>
          }
          panel={
            <>
              <OptionGroup title="调用参数">
                {!canExtract && (
                  <Notice tone="warn">
                    尚未配置模型，仅可返回原文。请前往{" "}
                    <Link href="/models" className="text-ink underline underline-offset-2">
                      模型接口
                    </Link>{" "}
                    页添加。
                  </Notice>
                )}
                {canExtract && chain.length === 0 && <Notice tone="info">抓取工具尚未指派提取模型，Agent 仅能获得原文。此处用所选模型试用提取回答。</Notice>}
                <p className="text-xs text-ink-3">
                  {extract ? "提取回答：提取模型读取整页内容，仅返回与问题相关的部分，这是 Agent 的默认调用方式。" : "原文：返回页面的 Markdown 原文，较长的页面分段返回。"}
                </p>
                {!extract && (
                  <Group label="起始位置" hint="读取的起始偏移量；续读长页面时填入上一段返回的位置">
                    <NumberInput className="w-36" min={0} suffix="字节" value={offset} aria-label="起始位置" onChange={(v) => setOffset(Math.round(v))} />
                  </Group>
                )}
                <Group label="绕过缓存" local hint={tuning.changed ? "已调整提供商参数，这次抓取本就不读写缓存。" : "重新向提供商请求页面，不读取也不写入页面缓存与回答缓存。"}>
                  <Switch checked={fresh} disabled={tuning.changed} onCheckedChange={setNoCache} aria-label="绕过缓存" />
                </Group>
              </OptionGroup>
              <ProviderParams tool="fetch" engine={engine} tuning={tuning} note="带临时参数的抓取不读写缓存。" />
            </>
          }
        >
          <input
            value={url}
            spellCheck={false}
            autoComplete="off"
            aria-label="URL"
            placeholder="https://example.com/article"
            className={cx(bare, "num h-12 text-sm")}
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
              rows={2}
              value={prompt}
              aria-label="针对页面的问题"
              placeholder="想从这个页面知道什么？例如：这个版本有哪些破坏性变更"
              className={cx(bare, "resize-none border-t border-line pt-3 pb-2 leading-6")}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onModEnter(submit)}
            />
          )}
        </Composer>
        {url.trim() === "" && <Examples items={["https://modelcontextprotocol.io/specification/draft/basic/transports", "https://go.dev/doc/devel/release"]} onPick={changeUrl} />}
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
                {run.variables?.route && <Badge>临时参数</Badge>}
                <span>{data.result.answer !== undefined ? "提取回答" : "原文"}</span>
                {data.result.content_length !== undefined && <span className="num">全文 {compact(data.result.content_length)} 字节</span>}
              </>
            )
          }
        >
          <TabPanel value="result" className="flex flex-col">
            {run.isPending ? (
              <Waiting label={run.variables?.url} elapsed={elapsed} />
            ) : run.error ? (
              <Failure error={run.error} />
            ) : data && format === "json" ? (
              <JSONView value={data.result} />
            ) : (
              data && (
                <FetchResultView
                  result={data.result}
                  from={run.variables?.offset ?? 0}
                  rendered={format === "rendered"}
                  onNext={(next) => {
                    // Reads on from the page that was fetched, with what it was fetched with, whatever the form says by now.
                    const ran = run.variables;
                    if (!ran) return;
                    setUrl(ran.url);
                    setEngine(ran.fetch_engine ?? "auto");
                    setAnswer(false);
                    setOffset(next);
                    send({ url: ran.url, prompt: "", raw: true, offset: next, fetch_engine: ran.fetch_engine, no_cache: ran.no_cache, route: ran.route });
                  }}
                />
              )
            )}
          </TabPanel>
          <TabPanel value="trace">
            <TraceView attempts={run.isPending ? undefined : data?.attempts} total={data?.duration_ms ?? 0} />
          </TabPanel>
        </Output>
      )}

      <Recent tool="fetch" stamp={run.isPending ? undefined : run.submittedAt || undefined} onPick={restore} />
    </>
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
