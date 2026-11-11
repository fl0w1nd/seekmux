import { RouteList } from "../components/RouteList";
import { takes, type CodeKind } from "../lib/codes";
import { useConfig } from "../lib/config";
import { CodeSelect } from "../ui/inputs";
import { NumberInput, Panel, Row } from "../ui/primitives";

export function SearchPage() {
  const { config, update, provider } = useConfig();

  // The enabled providers that will not send the chosen code.
  const skipped = (kind: CodeKind, code: string | undefined) => {
    if (!code) return undefined;
    const names = config.search.routes.filter((r) => r.enabled && !takes(provider(r.provider), kind, code)).map((r) => provider(r.provider).name);
    return names.length > 0 ? `${names.join("、")} 不支持，不发送` : undefined;
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel index="01" title="路由优先级" info="调用方可用 search_engine 指定提供商" flush>
        <RouteList tool="search" />
      </Panel>
      <Panel index="02" title="行为" flush>
        <Row label="总超时" hint="含回退">
          <NumberInput className="w-24" min={1} suffix="秒" value={config.search.timeout_seconds} onChange={(v) => update((d) => void (d.search.timeout_seconds = v))} />
        </Row>
        <Row label="默认地区" hint={skipped("country", config.search.country)} info="各提供商的参数中可单独设置">
          <CodeSelect kind="country" className="w-48" empty="不指定" value={config.search.country ?? ""} onChange={(code) => update((d) => void (d.search.country = code || undefined))} aria-label="默认地区" />
        </Row>
        <Row label="默认语言" hint={skipped("language", config.search.language)} info="Perplexity 只返回该语言的结果">
          <CodeSelect kind="language" className="w-48" empty="不指定" value={config.search.language ?? ""} onChange={(code) => update((d) => void (d.search.language = code || undefined))} aria-label="默认语言" />
        </Row>
      </Panel>
    </div>
  );
}
