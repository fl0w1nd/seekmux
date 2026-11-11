import { ModelChain } from "../components/ModelPicker";
import { RouteList } from "../components/RouteList";
import { useConfig } from "../lib/config";
import { Notice, NumberInput, Panel, Row, Switch, Textarea } from "../ui/primitives";

export function FetchPage() {
  const { config, update, meta } = useConfig();
  const fetch = config.fetch;
  const extract = fetch.extract;
  const configured = extract.models.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <Panel title="路由优先级" info="命中路由规则的 URL 不走此列表；调用方可用 fetch_engine 指定提供商。修改参数会清空页面缓存。" flush>
        <RouteList tool="fetch" />
      </Panel>

      <Panel title="行为" flush>
        <Row label="慢请求对冲" info="提供商超过阈值仍未返回时，并行请求下一个，采纳先成功的结果">
          <Switch checked={fetch.smart_fallback} onCheckedChange={(v) => update((d) => void (d.fetch.smart_fallback = v))} aria-label="慢请求对冲" />
          <NumberInput className="w-24" min={1} suffix="秒" disabled={!fetch.smart_fallback} value={fetch.slow_threshold_seconds} onChange={(v) => update((d) => void (d.fetch.slow_threshold_seconds = v))} aria-label="慢请求阈值" />
        </Row>
        <Row label="总超时">
          <NumberInput className="w-24" min={1} suffix="秒" value={fetch.timeout_seconds} onChange={(v) => update((d) => void (d.fetch.timeout_seconds = v))} />
        </Row>
        <Row label="缓存时长">
          <NumberInput className="w-24" min={1} suffix="秒" value={fetch.cache_ttl_seconds} onChange={(v) => update((d) => void (d.fetch.cache_ttl_seconds = Math.round(v)))} />
        </Row>
        <Row label="短页面直通" info="不超过该长度的页面直接返回原文，不经过模型。中日韩字符按 2 计。">
          <NumberInput className="w-28" min={1} suffix="字符" value={fetch.passthrough_length} onChange={(v) => update((d) => void (d.fetch.passthrough_length = Math.round(v)))} />
        </Row>
        <Row label="原文分页长度" info="raw 模式每次返回的上限，超出部分用 next_offset 续读">
          <NumberInput className="w-28" min={1} suffix="字符" value={fetch.raw_page_length} onChange={(v) => update((d) => void (d.fetch.raw_page_length = Math.round(v)))} />
        </Row>
      </Panel>

      <Panel title="提取模型" flush>
        {!configured && (
          <div className="border-b border-line px-4 py-2.5">
            <Notice tone="warn">未配置提取模型，fetch 只返回原文。</Notice>
          </div>
        )}
        <Row label="模型回退链" align="start">
          <div className="w-full max-w-xl">
            <ModelChain value={extract.models} onChange={(ids) => update((d) => void (d.fetch.extract.models = ids))} />
          </div>
        </Row>
        <Row label="全部失败时返回原文" info="关闭则等待限流恢复，全部失败时报错">
          <Switch checked={extract.raw_on_failure} onCheckedChange={(v) => update((d) => void (d.fetch.extract.raw_on_failure = v))} aria-label="全部失败时返回原文" />
        </Row>
        <Row label="单次输入上限" info="超出的页面分段提取">
          <NumberInput className="w-32" min={1} suffix="字符" value={extract.max_input_length} onChange={(v) => update((d) => void (d.fetch.extract.max_input_length = Math.round(v)))} />
        </Row>
        <Row label="首字超时" info="未收到首个 Token 即重试">
          <NumberInput className="w-28" min={1} suffix="ms" value={extract.first_chunk_timeout_ms} onChange={(v) => update((d) => void (d.fetch.extract.first_chunk_timeout_ms = Math.round(v)))} />
          <span className="text-xs text-ink-3">重试次数</span>
          <NumberInput className="w-20" min={1} suffix="次" value={extract.max_retries} onChange={(v) => update((d) => void (d.fetch.extract.max_retries = Math.round(v)))} aria-label="首字重试次数" />
        </Row>
        <Row label="流式总超时" info="超时返回已生成的部分">
          <NumberInput className="w-28" min={1} suffix="ms" value={extract.stream_total_timeout_ms} onChange={(v) => update((d) => void (d.fetch.extract.stream_total_timeout_ms = Math.round(v)))} />
          <span className="text-xs text-ink-3">最大输出</span>
          <NumberInput className="w-32" min={0} suffix="Token" zero="沿用模型" value={extract.max_output_tokens ?? 0} onChange={(v) => update((d) => void (d.fetch.extract.max_output_tokens = Math.round(v) || undefined))} aria-label="最大输出 Token" />
        </Row>
        <Row label="系统提示词" align="start">
          <Textarea className="max-w-2xl" rows={5} value={extract.system_prompt ?? ""} placeholder={meta.prompts.extract} onChange={(e) => update((d) => void (d.fetch.extract.system_prompt = e.target.value || undefined))} aria-label="提取系统提示词" />
        </Row>
      </Panel>
    </div>
  );
}
