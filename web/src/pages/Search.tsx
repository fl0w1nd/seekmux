import { RouteList } from "../components/RouteList";
import { useConfig } from "../lib/config";
import { PageHeader } from "../Shell";
import { Input, NumberInput, Panel, Row } from "../ui/primitives";

export function SearchPage() {
  const { config, update } = useConfig();
  return (
    <>
      <PageHeader title="搜索" description="search 工具的提供商路由。auto 模式按以下顺序尝试：遇到限流、出错或超时时，立即切换到下一个提供商。" />
      <div className="flex flex-col gap-4">
        <Panel index="01" title="路由优先级" description="按从上到下的顺序依次尝试。调用方也可通过 search_engine 参数指定提供商。各提供商的专有参数在「参数」中设置。" flush>
          <RouteList tool="search" />
        </Panel>
        <Panel index="02" title="行为" flush>
          <Row label="总超时" hint="单次查询（含全部回退尝试）的时间上限">
            <NumberInput className="w-24" min={1} suffix="秒" value={config.search.timeout_seconds} onChange={(v) => update((d) => void (d.search.timeout_seconds = v))} />
          </Row>
          <Row label="默认地区" hint="两位国家码，如 US、CN、JP。传递给所有支持地区参数的提供商，可在各提供商的「参数」中单独覆盖；留空则不指定">
            <Input mono className="w-24" maxLength={2} placeholder="不指定" value={config.search.country ?? ""} onChange={(e) => update((d) => void (d.search.country = e.target.value.trim().toUpperCase() || undefined))} />
          </Row>
          <Row label="默认语言" hint="两位语言码，如 zh、en、ja。部分提供商仅优先返回该语言，Perplexity 会剔除其他语言的结果；Exa 不支持该参数">
            <Input mono className="w-24" maxLength={2} placeholder="不指定" value={config.search.language ?? ""} onChange={(e) => update((d) => void (d.search.language = e.target.value.trim().toLowerCase() || undefined))} />
          </Row>
        </Panel>
      </div>
    </>
  );
}
