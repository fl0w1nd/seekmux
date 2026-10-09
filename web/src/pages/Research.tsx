import { ModelSelect } from "../components/ModelPicker";
import { useConfig } from "../lib/config";
import { PageHeader } from "../Shell";
import { Field, Notice, NumberInput, Panel, Row, Segmented, Switch, Textarea } from "../ui/primitives";

export function ResearchPage() {
  const { config, update, meta } = useConfig();
  const research = config.research;
  const configured = Boolean(research.model);
  const extractReady = config.fetch.extract.models.length > 0;

  return (
    <>
      <PageHeader
        title="深度研究"
        description="将问题整体交由云端的研究 Agent 处理：Agent 使用本网关的搜索与抓取反复查证，最终返回附带出处的报告。启用后 MCP 将新增 research、research_start、research_result 三个工具。"
      />
      <div className="flex flex-col gap-4">
        <Panel index="01" title="开关" flush>
          <Row label="启用研究工具" hint="需先选定下方的研究模型">
            <Switch checked={research.enabled} onCheckedChange={(v) => update((d) => void (d.research.enabled = v))} aria-label="启用研究工具" />
          </Row>
        </Panel>

        <Panel index="02" title="研究模型" description="驱动整个研究过程的主模型，须支持工具调用。研究仅使用这一个模型，不做故障转移：一次研究的多轮请求依赖同一模型的提示词缓存。">
          <div className="flex flex-col gap-4">
            {research.enabled && !configured && <Notice tone="err">已启用研究但未选择模型，配置无法保存。</Notice>}
            <ModelSelect value={research.model} onChange={(id) => update((d) => void (d.research.model = id))} />
          </div>
        </Panel>

        <Panel index="03" title="阅读方式" description="研究 Agent 读取网页时获得的内容形式。" flush>
          <Row
            label="网页内容"
            hint={
              research.reading === "raw"
                ? "研究模型直接读取网页原文，长页面分段读取。最接近一手材料，占用的上下文也最多。"
                : extractReady
                  ? "由「抓取」页的提取模型先按研究模型的提问归纳各网页，仅将答案交给研究模型。节省上下文，但准确度取决于提取模型。"
                  : "尚未配置提取模型，网页将按原文返回。请先在「抓取」页选定提取模型。"
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

        <Panel index="04" title="预算" description="任一项耗尽时，Agent 将停止检索并基于现有材料撰写报告。" flush>
          <Row label="最大步数" hint="一步为模型的一轮推理，可并行发起多次搜索和抓取">
            <NumberInput className="w-24" min={1} suffix="步" value={research.max_steps} onChange={(v) => update((d) => void (d.research.max_steps = Math.round(v)))} />
          </Row>
          <Row label="最长用时" hint="达到 80% 时开始收尾并撰写报告">
            <NumberInput className="w-24" min={30} suffix="秒" value={research.max_duration_seconds} onChange={(v) => update((d) => void (d.research.max_duration_seconds = Math.round(v)))} />
          </Row>
          <Row label="token 上限" hint="各步输入与输出 token 的累计值，用于约束总花费">
            <NumberInput className="w-32" min={1000} suffix="token" value={research.max_tokens} onChange={(v) => update((d) => void (d.research.max_tokens = Math.round(v)))} />
          </Row>
          <Row label="上下文上限" hint="单次请求的输入规模；应低于模型的上下文窗口并留出余量，超出后上游将直接拒绝请求">
            <NumberInput className="w-32" min={1000} suffix="token" value={research.max_context_tokens} onChange={(v) => update((d) => void (d.research.max_context_tokens = Math.round(v)))} />
          </Row>
        </Panel>

        <Panel index="05" title="系统提示词">
          <Field label="研究 Agent 的指令" hint="留空则使用内置提示词；{{date}} 将替换为当天日期">
            <Textarea rows={12} value={research.system_prompt ?? ""} placeholder={meta.prompts.research} onChange={(e) => update((d) => void (d.research.system_prompt = e.target.value || undefined))} />
          </Field>
        </Panel>
      </div>
    </>
  );
}
