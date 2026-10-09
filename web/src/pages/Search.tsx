import { RouteList } from "../components/RouteList";
import { useConfig } from "../lib/config";
import { PageHeader } from "../Shell";
import { NumberInput, Panel, Row } from "../ui/primitives";

export function SearchPage() {
  const { config, update } = useConfig();
  return (
    <>
      <PageHeader title="搜索" description="search 工具的提供商路由。auto 模式按下面的顺序尝试：遇到限流立即换下一家，出错或超时也换下一家。" />
      <div className="flex flex-col gap-4">
        <Panel index="01" title="路由优先级" description="从上到下依次尝试。调用方也可以用 search_engine 参数指定其中一家。" flush>
          <RouteList tool="search" />
        </Panel>
        <Panel index="02" title="行为" flush>
          <Row label="总超时" hint="一次查询连同所有回退尝试的时间上限">
            <NumberInput className="w-24" min={1} suffix="秒" value={config.search.timeout_seconds} onChange={(v) => update((d) => void (d.search.timeout_seconds = v))} />
          </Row>
        </Panel>
      </div>
    </>
  );
}
