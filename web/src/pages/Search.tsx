import { RouteList } from "../components/RouteList";
import { useConfig } from "../lib/config";
import { PageHeader } from "../Shell";
import { Input, NumberInput, Panel, Row } from "../ui/primitives";

export function SearchPage() {
  const { config, update } = useConfig();
  return (
    <>
      <PageHeader title="搜索" description="search 工具的提供商路由。auto 模式按下面的顺序尝试：遇到限流立即换下一家，出错或超时也换下一家。" />
      <div className="flex flex-col gap-4">
        <Panel index="01" title="路由优先级" description="从上到下依次尝试。调用方也可以用 search_engine 参数指定其中一家。每家自己的参数在「参数」里。" flush>
          <RouteList tool="search" />
        </Panel>
        <Panel index="02" title="行为" flush>
          <Row label="总超时" hint="一次查询连同所有回退尝试的时间上限">
            <NumberInput className="w-24" min={1} suffix="秒" value={config.search.timeout_seconds} onChange={(v) => update((d) => void (d.search.timeout_seconds = v))} />
          </Row>
          <Row label="默认地区" hint="两位国家码，如 US、CN、JP。传给每个支持地区参数的提供商，可在各家的「参数」里单独覆盖；留空不指定">
            <Input mono className="w-24" maxLength={2} placeholder="不指定" value={config.search.country ?? ""} onChange={(e) => update((d) => void (d.search.country = e.target.value.trim().toUpperCase() || undefined))} />
          </Row>
          <Row label="默认语言" hint="两位语言码，如 zh、en、ja。有的提供商只是优先这种语言，Perplexity 会去掉其他语言的结果；Exa 没有这个参数">
            <Input mono className="w-24" maxLength={2} placeholder="不指定" value={config.search.language ?? ""} onChange={(e) => update((d) => void (d.search.language = e.target.value.trim().toLowerCase() || undefined))} />
          </Row>
        </Panel>
      </div>
    </>
  );
}
