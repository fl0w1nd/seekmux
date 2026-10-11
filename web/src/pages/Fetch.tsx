import { Link } from "wouter";
import { ModelChain } from "../components/ModelPicker";
import { RouteList } from "../components/RouteList";
import { useConfig } from "../lib/config";
import { ToolIntro } from "../Shell";
import { Field, Notice, NumberInput, Panel, Row, Switch, Textarea } from "../ui/primitives";

export function FetchPage() {
  const { config, update, meta } = useConfig();
  const fetch = config.fetch;
  const extract = fetch.extract;
  const configured = extract.models.length > 0;

  return (
    <>
      <ToolIntro>fetch 工具先通过提供商获取页面，再由提取模型按 Prompt 提炼回答，仅向 Agent 返回提取结果。</ToolIntro>
      <div className="flex flex-col gap-4">
        <Panel
          index="01"
          title="路由优先级"
          description={
            <>
              按从上到下的顺序依次尝试。调用方也可通过 fetch_engine 参数指定提供商。各提供商的专有参数在「参数」中设置，修改后页面缓存将被清空。命中
              <Link href="/routing/rules" className="underline underline-offset-2 hover:text-ink">
                服务路由
              </Link>
              规则的 URL 不走此列表。
            </>
          }
          flush
        >
          <RouteList tool="fetch" />
        </Panel>

        <Panel index="02" title="行为" flush>
          <Row label="慢请求对冲" hint="提供商响应过慢时，并行向下一个提供商发起对冲请求，采纳首个成功的结果">
            <Switch checked={fetch.smart_fallback} onCheckedChange={(v) => update((d) => void (d.fetch.smart_fallback = v))} aria-label="慢请求对冲" />
          </Row>
          <Row label="慢请求阈值" hint="超过该时间仍未返回时，向下一个提供商发起对冲请求">
            <NumberInput className="w-24" min={1} suffix="秒" disabled={!fetch.smart_fallback} value={fetch.slow_threshold_seconds} onChange={(v) => update((d) => void (d.fetch.slow_threshold_seconds = v))} />
          </Row>
          <Row label="总超时" hint="获取单个页面的时间上限">
            <NumberInput className="w-24" min={1} suffix="秒" value={fetch.timeout_seconds} onChange={(v) => update((d) => void (d.fetch.timeout_seconds = v))} />
          </Row>
          <Row label="页面缓存" hint="该时间内针对同一 URL 的后续请求不会重新抓取">
            <NumberInput className="w-24" min={1} suffix="秒" value={fetch.cache_ttl_seconds} onChange={(v) => update((d) => void (d.fetch.cache_ttl_seconds = Math.round(v)))} />
          </Row>
          <Row label="短页面直通" hint="不超过该长度的页面直接返回原文，不经过提取模型（中日韩字符按 2 计）">
            <NumberInput className="w-28" min={1} suffix="字符" value={fetch.passthrough_length} onChange={(v) => update((d) => void (d.fetch.passthrough_length = Math.round(v)))} />
          </Row>
          <Row label="原文分页长度" hint="raw 模式每次返回的原文上限，超出部分通过 next_offset 续读">
            <NumberInput className="w-28" min={1} suffix="字符" value={fetch.raw_page_length} onChange={(v) => update((d) => void (d.fetch.raw_page_length = Math.round(v)))} />
          </Row>
        </Panel>

        <Panel index="03" title="提取模型" description="读取整个页面并按 Prompt 提炼回答的辅助模型，建议选用成本低、速度快、上下文长的模型。可配置多个：首选失败或被限流时，请求转交下一个。">
          <div className="flex flex-col gap-4">
            {!configured && <Notice tone="warn">未配置提取模型：fetch 将直接返回页面原文，占用调用方更多上下文。</Notice>}
            <ModelChain value={extract.models} onChange={(ids) => update((d) => void (d.fetch.extract.models = ids))} />
            <div className="flex items-center justify-between gap-6 rounded-ctl border border-line px-3 py-2.5">
              <div>
                <div className="text-sm">全部故障时降级为原文</div>
                <div className="text-xs text-ink-3">所有模型故障或限流时直接返回原文；关闭则等待限流恢复，全部失败时报错</div>
              </div>
              <Switch checked={extract.raw_on_failure} onCheckedChange={(v) => update((d) => void (d.fetch.extract.raw_on_failure = v))} aria-label="全部故障时降级为原文" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="单次输入上限" hint="超出的页面分段提取">
                <NumberInput min={1} suffix="字符" value={extract.max_input_length} onChange={(v) => update((d) => void (d.fetch.extract.max_input_length = Math.round(v)))} />
              </Field>
              <Field label="首字超时" hint="未收到首个 Token 时重试">
                <NumberInput min={1} suffix="ms" value={extract.first_chunk_timeout_ms} onChange={(v) => update((d) => void (d.fetch.extract.first_chunk_timeout_ms = Math.round(v)))} />
              </Field>
              <Field label="首字重试次数">
                <NumberInput min={1} value={extract.max_retries} onChange={(v) => update((d) => void (d.fetch.extract.max_retries = Math.round(v)))} />
              </Field>
              <Field label="最大输出 Token" hint="0 为沿用模型自身的上限">
                <NumberInput min={0} suffix="Token" value={extract.max_output_tokens ?? 0} onChange={(v) => update((d) => void (d.fetch.extract.max_output_tokens = Math.round(v) || undefined))} />
              </Field>
              <Field label="流式总超时" hint="超时后返回已生成的部分">
                <NumberInput min={1} suffix="ms" value={extract.stream_total_timeout_ms} onChange={(v) => update((d) => void (d.fetch.extract.stream_total_timeout_ms = Math.round(v)))} />
              </Field>
            </div>
            <Field label="系统提示词" hint="留空使用内置提示词（下方灰色文字即内置内容）">
              <Textarea rows={8} value={extract.system_prompt ?? ""} placeholder={meta.prompts.extract} onChange={(e) => update((d) => void (d.fetch.extract.system_prompt = e.target.value || undefined))} />
            </Field>
          </div>
        </Panel>
      </div>
    </>
  );
}
