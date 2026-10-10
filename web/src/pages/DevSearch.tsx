import { RouteList } from "../components/RouteList";
import { useConfig } from "../lib/config";
import { PageHeader } from "../Shell";
import { NumberInput, Panel, Row } from "../ui/primitives";

export function DevSearchPage() {
  const { config, update } = useConfig();
  return (
    <>
      <PageHeader
        title="开发者搜索"
        description="dev_search 工具检索公开代码仓库的 issue、已合并 PR、README 与文档站，而非开放网页；每条结果附带匹配的原文段落，通常无需再抓取页面。"
      />
      <div className="flex flex-col gap-4">
        <Panel
          index="01"
          title="路由优先级"
          description="按从上到下的顺序依次尝试。仅当至少一个提供商可用，且访问密钥勾选了该工具时，dev_search 才会出现在 MCP 工具列表中。各提供商的专有参数在「参数」中设置。"
          flush
        >
          <RouteList tool="dev_search" />
        </Panel>
        <Panel index="02" title="行为" flush>
          <Row label="总超时" hint="单次查询（含重试）的时间上限">
            <NumberInput className="w-24" min={1} suffix="秒" value={config.dev_search.timeout_seconds} onChange={(v) => update((d) => void (d.dev_search.timeout_seconds = v))} />
          </Row>
        </Panel>
      </div>
    </>
  );
}
