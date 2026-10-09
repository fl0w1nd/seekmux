import { ModelChain } from "../components/ModelPicker";
import { RouteList } from "../components/RouteList";
import { useConfig } from "../lib/config";
import { PageHeader } from "../Shell";
import { Field, Notice, NumberInput, Panel, Row, Switch, Textarea } from "../ui/primitives";

export function FetchPage() {
  const { config, update, meta } = useConfig();
  const fetch = config.fetch;
  const extract = fetch.extract;
  const configured = extract.models.length > 0;

  return (
    <>
      <PageHeader title="抓取" description="fetch 工具先通过提供商取回页面，再由提取模型针对调用方的 prompt 作答，只把答案返回给 Agent。" />
      <div className="flex flex-col gap-4">
        <Panel index="01" title="路由优先级" description="从上到下依次尝试。调用方也可以用 fetch_engine 参数指定其中一家。" flush>
          <RouteList tool="fetch" />
        </Panel>

        <Panel index="02" title="行为" flush>
          <Row label="竞速回退" hint="当前提供商迟迟不返回时，同时向下一家发起请求，谁先成功用谁">
            <Switch checked={fetch.smart_fallback} onCheckedChange={(v) => update((d) => void (d.fetch.smart_fallback = v))} aria-label="竞速回退" />
          </Row>
          <Row label="慢请求阈值" hint="超过这个时间还没返回，就启动下一家竞速">
            <NumberInput className="w-24" min={1} suffix="秒" disabled={!fetch.smart_fallback} value={fetch.slow_threshold_seconds} onChange={(v) => update((d) => void (d.fetch.slow_threshold_seconds = v))} />
          </Row>
          <Row label="总超时" hint="取回一个页面的时间上限">
            <NumberInput className="w-24" min={1} suffix="秒" value={fetch.timeout_seconds} onChange={(v) => update((d) => void (d.fetch.timeout_seconds = v))} />
          </Row>
          <Row label="页面缓存" hint="同一 URL 在这段时间内的追问不会重新抓取">
            <NumberInput className="w-24" min={1} suffix="秒" value={fetch.cache_ttl_seconds} onChange={(v) => update((d) => void (d.fetch.cache_ttl_seconds = Math.round(v)))} />
          </Row>
          <Row label="短页面直通" hint="不超过这个长度的页面直接返回原文，不经过提取模型（中日韩字符按 2 计）">
            <NumberInput className="w-28" min={1} suffix="字符" value={fetch.passthrough_length} onChange={(v) => update((d) => void (d.fetch.passthrough_length = Math.round(v)))} />
          </Row>
          <Row label="原文分页长度" hint="raw 模式每次返回的原文上限，超出部分用 next_offset 续读">
            <NumberInput className="w-28" min={1} suffix="字符" value={fetch.raw_page_length} onChange={(v) => update((d) => void (d.fetch.raw_page_length = Math.round(v)))} />
          </Row>
        </Panel>

        <Panel index="03" title="提取模型" description="读完整个页面并回答 prompt 的辅助模型，建议用便宜、快速、上下文长的。可以排多个：首选失败或被限流时，请求交给下一个。">
          <div className="flex flex-col gap-4">
            {!configured && <Notice tone="warn">未配置提取模型：fetch 会直接返回页面原文，消耗调用方更多上下文。</Notice>}
            <ModelChain value={extract.models} onChange={(ids) => update((d) => void (d.fetch.extract.models = ids))} />
            <div className="flex items-center justify-between gap-6 rounded-ctl border border-line px-3 py-2.5">
              <div>
                <div className="text-sm">全部不可用时退回原文</div>
                <div className="text-xs text-ink-3">链上的模型都失败或被限流时，不等待、不报错，直接返回页面原文并附带说明。关闭后会等限流窗口释放，都失败则返回错误</div>
              </div>
              <Switch checked={extract.raw_on_failure} onCheckedChange={(v) => update((d) => void (d.fetch.extract.raw_on_failure = v))} aria-label="全部不可用时退回原文" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="单次输入上限" hint="超出的页面分段作答">
                <NumberInput min={1} suffix="字符" value={extract.max_input_length} onChange={(v) => update((d) => void (d.fetch.extract.max_input_length = Math.round(v)))} />
              </Field>
              <Field label="首包超时" hint="流未开始则重试">
                <NumberInput min={1} suffix="ms" value={extract.first_chunk_timeout_ms} onChange={(v) => update((d) => void (d.fetch.extract.first_chunk_timeout_ms = Math.round(v)))} />
              </Field>
              <Field label="首包重试次数">
                <NumberInput min={1} value={extract.max_retries} onChange={(v) => update((d) => void (d.fetch.extract.max_retries = Math.round(v)))} />
              </Field>
              <Field label="最大输出 token" hint="0 为跟随模型自己的上限">
                <NumberInput min={0} suffix="token" value={extract.max_output_tokens ?? 0} onChange={(v) => update((d) => void (d.fetch.extract.max_output_tokens = Math.round(v) || undefined))} />
              </Field>
              <Field label="流总超时" hint="超时返回已生成部分">
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
