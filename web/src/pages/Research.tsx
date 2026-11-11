import { Link } from "wouter";
import { ModelSelect } from "../components/ModelPicker";
import { useConfig } from "../lib/config";
import { budgetInfo, readingText } from "../lib/research";
import { Notice, NumberInput, Panel, Row, Segmented, Switch, Textarea } from "../ui/primitives";

export function ResearchPage() {
  const { config, update, meta } = useConfig();
  const research = config.research;
  const configured = Boolean(research.model);
  const extractReady = config.fetch.extract.models.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <Panel title="模型与读取" info="研究模型需支持工具调用" flush>
        {research.enabled && !configured && <Notice tone="err" className="m-4 mb-0">未选择研究模型，配置无法保存。</Notice>}
        <Row label="研究模型">
          <ModelSelect value={research.model} onChange={(id) => update((d) => void (d.research.model = id))} />
        </Row>
        <Row label="启用研究工具" hint={!configured && !research.enabled ? "先选择研究模型" : undefined} info="启用后提供 research、research_start、research_result、research_cancel 四个工具">
          <Switch
            checked={research.enabled}
            disabled={!configured && !research.enabled}
            onCheckedChange={(v) => update((d) => void (d.research.enabled = v))}
            aria-label="启用研究工具"
          />
        </Row>
        <Row
          label="网页读取方式"
          hint={
            research.reading === "extract" && !extractReady ? (
              <>
                {readingText("extract", false)}，
                <Link href="/tools/fetch" className="underline underline-offset-2 hover:text-ink">
                  去设置
                </Link>
              </>
            ) : (
              readingText(research.reading, extractReady)
            )
          }
        >
          <Segmented
            value={research.reading}
            onChange={(reading) => update((d) => void (d.research.reading = reading))}
            options={[
              { value: "raw", label: "原文" },
              { value: "extract", label: "归纳" },
            ]}
          />
        </Row>
      </Panel>

      <Panel title="运行预算" info="任一项用尽时，Agent 停止检索，基于已有材料撰写报告" flush>
        <Row label="最大步数" info={budgetInfo.max_steps}>
          <NumberInput className="w-24" min={1} suffix="步" value={research.max_steps} onChange={(v) => update((d) => void (d.research.max_steps = Math.round(v)))} />
        </Row>
        <Row label="最长用时" info={budgetInfo.max_duration_seconds}>
          <NumberInput className="w-24" min={30} suffix="秒" value={research.max_duration_seconds} onChange={(v) => update((d) => void (d.research.max_duration_seconds = Math.round(v)))} />
        </Row>
        <Row label="Token 上限" info={budgetInfo.max_tokens}>
          <NumberInput className="w-32" min={1000} suffix="Token" value={research.max_tokens} onChange={(v) => update((d) => void (d.research.max_tokens = Math.round(v)))} />
        </Row>
        <Row label="上下文上限" info={budgetInfo.max_context_tokens}>
          <NumberInput className="w-32" min={1000} suffix="Token" value={research.max_context_tokens} onChange={(v) => update((d) => void (d.research.max_context_tokens = Math.round(v)))} />
        </Row>
        <Row label="单次等待时长" hint="应低于客户端的工具超时" info="research_result 在任务未完成时最多等待这么久，超时返回进度，由调用方再次调用">
          <NumberInput className="w-24" min={5} suffix="秒" value={research.result_wait_seconds} onChange={(v) => update((d) => void (d.research.result_wait_seconds = Math.round(v)))} />
        </Row>
      </Panel>

      <Panel title="系统提示词" actions={<span className="num text-2xs text-ink-3">支持 {"{{date}}"}</span>}>
        <Textarea
          rows={9}
          aria-label="研究 Agent 的指令"
          value={research.system_prompt ?? ""}
          placeholder={meta.prompts.research}
          onChange={(e) => update((d) => void (d.research.system_prompt = e.target.value || undefined))}
        />
      </Panel>
    </div>
  );
}
