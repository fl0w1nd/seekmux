import { RouteList } from "../components/RouteList";
import { useConfig } from "../lib/config";
import { Notice, NumberInput, Panel, Row } from "../ui/primitives";

export function DevSearchPage() {
  const { config, update } = useConfig();
  const ready = config.dev_search.routes.some((route) => {
    const creds = config.providers[route.provider];
    return route.enabled && Boolean(creds?.api_key || (creds?.api_key_hint && !creds.clear_api_key));
  });
  return (
    <div className="flex flex-col gap-3">
      {!ready && <Notice tone="warn">没有可用的提供商，dev_search 不会出现在 MCP 工具列表中。</Notice>}
      <Panel index="01" title="路由优先级" flush>
        <RouteList tool="dev_search" />
      </Panel>
      <Panel index="02" title="行为" flush>
        <Row label="总超时" hint="含重试">
          <NumberInput className="w-24" min={1} suffix="秒" value={config.dev_search.timeout_seconds} onChange={(v) => update((d) => void (d.dev_search.timeout_seconds = v))} />
        </Row>
      </Panel>
    </div>
  );
}
