import { ModelSelect } from "../components/ModelPicker";
import { useConfig } from "../lib/config";
import { PageHeader } from "../Shell";
import { Field, Notice, NumberInput, Panel, Row, Switch, Textarea } from "../ui/primitives";

export function ResearchPage() {
  const { config, update, meta } = useConfig();
  const research = config.research;
  const configured = Boolean(research.model);

  return (
    <>
      <PageHeader
        title="深度研究"
        description="把一个问题整个交给云端的研究 Agent：它自己用本网关的搜索和抓取反复查证，最后返回带出处的报告。启用后 MCP 会多出 research、research_start、research_result 三个工具。"
      />
      <div className="flex flex-col gap-4">
        <Panel index="01" title="开关" flush>
          <Row label="启用研究工具" hint="需要先选好下面的研究模型">
            <Switch checked={research.enabled} onCheckedChange={(v) => update((d) => void (d.research.enabled = v))} aria-label="启用研究工具" />
          </Row>
        </Panel>

        <Panel index="02" title="研究模型" description="驱动整个研究过程的主模型，需要支持工具调用。研究只用这一个模型、不做故障转移：一次研究的多轮请求依赖同一模型的提示词缓存。">
          <div className="flex flex-col gap-4">
            {research.enabled && !configured && <Notice tone="err">已启用研究但没有选模型，这样无法保存。</Notice>}
            <ModelSelect value={research.model} onChange={(id) => update((d) => void (d.research.model = id))} />
          </div>
        </Panel>

        <Panel index="03" title="预算" description="任何一项用完，Agent 都会被要求停止检索、用已有材料写出报告。" flush>
          <Row label="最大步数" hint="一步是模型的一轮思考，可以并行发起多次搜索和抓取">
            <NumberInput className="w-24" min={1} suffix="步" value={research.max_steps} onChange={(v) => update((d) => void (d.research.max_steps = Math.round(v)))} />
          </Row>
          <Row label="最长用时" hint="到达 80% 时开始收尾写报告">
            <NumberInput className="w-24" min={30} suffix="秒" value={research.max_duration_seconds} onChange={(v) => update((d) => void (d.research.max_duration_seconds = Math.round(v)))} />
          </Row>
          <Row label="token 上限" hint="各步输入加输出 token 的累计值">
            <NumberInput className="w-32" min={1000} suffix="token" value={research.max_tokens} onChange={(v) => update((d) => void (d.research.max_tokens = Math.round(v)))} />
          </Row>
        </Panel>

        <Panel index="04" title="系统提示词">
          <Field label="研究 Agent 的指令" hint="留空使用内置提示词；{{date}} 会替换为当天日期">
            <Textarea rows={12} value={research.system_prompt ?? ""} placeholder={meta.prompts.research} onChange={(e) => update((d) => void (d.research.system_prompt = e.target.value || undefined))} />
          </Field>
        </Panel>
      </div>
    </>
  );
}
