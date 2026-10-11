import { ArrowDown, ArrowUp, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Link, Redirect, useLocation, useParams } from "wouter";
import type { Config, Rule } from "../lib/api";
import { useConfig } from "../lib/config";
import { cleanPattern, newRuleID, routingRules, validPattern } from "../lib/routing";
import { PageHeader } from "../Shell";
import { ChipInput } from "../ui/inputs";
import { Dialog, useConfirm } from "../ui/overlays";
import { Badge, Button, cx, Field, Input, Notice, Panel, Switch, TabList, TabPanel, Tabs } from "../ui/primitives";

const tabs = [{ value: "rules", label: "规则" }];

/** Whether a provider can be called: it has an API key or needs none. */
function useCredentials() {
  const { config, provider } = useConfig();
  return (id: string) => {
    const creds = config.providers[id];
    return !provider(id).key_required || Boolean(creds?.api_key || (creds?.api_key_hint && !creds.clear_api_key));
  };
}

/** Which providers read which pages. */
export function RoutingPage() {
  const { tab } = useParams<{ tab: string }>();
  const [, navigate] = useLocation();
  // The rule in the dialog; one the configuration does not hold yet is new.
  const [form, setForm] = useState<Rule | null>(null);
  if (!tabs.some((t) => t.value === tab)) return <Redirect to="/routing/rules" replace />;

  return (
    <>
      <PageHeader
        title="服务路由"
        description="按 URL 决定由哪些提供商抓取：有些页面只有个别提供商能读出内容。"
        actions={
          tab === "rules" && (
            <Button variant="primary" icon={<Plus />} onClick={() => setForm({ id: newRuleID(), name: "", enabled: true, match: [], providers: [] })}>
              新建规则
            </Button>
          )
        }
      />
      <Tabs value={tab} onChange={(value) => navigate(`/routing/${value}`)}>
        <TabList flush tabs={tabs} />
        <TabPanel value={tab} className="pt-6">
          <Rules onEdit={setForm} />
        </TabPanel>
      </Tabs>
      {form && <RuleDialog rule={form} onClose={() => setForm(null)} />}
    </>
  );
}

/** Sets a built-in rule's change, dropping what merely repeats the rule. */
function changeBuiltin(draft: Config, id: string, change: { enabled?: boolean; providers?: string[] }) {
  const next = { ...draft.routing.builtin?.[id], ...change };
  const builtin = { ...draft.routing.builtin, [id]: next };
  if (!next.enabled && !next.providers?.length) delete builtin[id];
  draft.routing.builtin = Object.keys(builtin).length > 0 ? builtin : undefined;
}

function Rules({ onEdit }: { onEdit: (rule: Rule) => void }) {
  const { config, meta, update, provider } = useConfig();
  const usable = useCredentials();
  const rules = routingRules(config, meta);
  const own = config.routing.rules.length;

  const move = (index: number, by: number) =>
    update((draft) => {
      const list = draft.routing.rules;
      [list[index], list[index + by]] = [list[index + by], list[index]];
    });
  const enable = (rule: Rule, index: number, enabled: boolean) =>
    update((draft) => {
      if (rule.builtin) changeBuiltin(draft, rule.id, { enabled });
      else draft.routing.rules[index].enabled = enabled;
    });

  return (
    <Panel
      index="01"
      title="路由规则"
      description="URL 命中规则时，只在规则列出的提供商中依次尝试，不再走抓取工具的路由优先级；提供商配置了密钥即可，无需在抓取路由中启用。自上而下匹配，命中第一条即止。内置规则默认停用，需手动开启。调用方通过 fetch_engine 指定提供商时不套用规则。"
      flush
    >
      <ol>
        {rules.map((rule, index) => {
          const ready = rule.providers.some(usable);
          return (
            <li key={rule.id} className={cx("flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0", !rule.enabled && "opacity-60")}>
              <span className={cx("num w-6 text-sm", rule.enabled && ready ? "text-signal-text" : "text-ink-3")}>{String(index + 1).padStart(2, "0")}</span>
              <span className="flex w-7 flex-col">
                {!rule.builtin && (
                  <>
                    <Button size="sm" variant="ghost" className="h-4" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)} />
                    <Button size="sm" variant="ghost" className="h-4" icon={<ArrowDown />} aria-label="下移" disabled={index === own - 1} onClick={() => move(index, 1)} />
                  </>
                )}
              </span>
              <div className="min-w-48 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {rule.name}
                  {rule.builtin && <Badge>内置</Badge>}
                  {!rule.enabled ? (
                    <Badge>已停用</Badge>
                  ) : ready ? (
                    <Badge tone="ok" dot>
                      生效
                    </Badge>
                  ) : (
                    <Link href="/providers">
                      <Badge tone="warn" dot>
                        缺少密钥
                      </Badge>
                    </Link>
                  )}
                </div>
                <div className="num mt-1 text-xs break-all text-ink-3">{rule.match.join(" · ")}</div>
              </div>
              <div className="flex flex-col gap-1 text-right">
                <span className="tag">提供商</span>
                <span className="text-xs text-ink-2">{rule.providers.map((id) => provider(id).name).join(" → ")}</span>
              </div>
              <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => onEdit(rule)}>
                编辑
              </Button>
              <Switch checked={rule.enabled} onCheckedChange={(enabled) => enable(rule, index, enabled)} aria-label={`启用规则 ${rule.name}`} />
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function RuleDialog({ rule, onClose }: { rule: Rule; onClose: () => void }) {
  const { config, meta, update, provider } = useConfig();
  const usable = useCredentials();
  const confirm = useConfirm();
  const [name, setName] = useState(rule.name);
  const [match, setMatch] = useState(rule.match);
  const [chosen, setChosen] = useState(rule.providers);

  const builtin = meta.rules.find((r) => r.id === rule.id);
  const stored = config.routing.rules.findIndex((r) => r.id === rule.id);
  const fetchers = meta.catalog.filter((info) => info.tools.includes("fetch")).map((info) => info.id);
  const lanes = [...chosen, ...fetchers.filter((id) => !chosen.includes(id))];
  const invalid = match.filter((pattern) => !validPattern(pattern));
  const ready = (builtin || name.trim()) && match.length > 0 && invalid.length === 0 && chosen.length > 0;

  const move = (index: number, by: number) => {
    const next = [...chosen];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    setChosen(next);
  };
  const save = () => {
    update((draft) => {
      if (builtin) {
        const same = chosen.length === builtin.providers.length && chosen.every((id, i) => id === builtin.providers[i]);
        changeBuiltin(draft, builtin.id, { providers: same ? undefined : chosen });
        return;
      }
      const next: Rule = { id: rule.id, name: name.trim(), enabled: rule.enabled, match, providers: chosen };
      if (stored >= 0) draft.routing.rules[stored] = next;
      else draft.routing.rules.push(next);
    });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={builtin ? `内置规则「${rule.name}」` : stored >= 0 ? "编辑规则" : "新建规则"}
      description={builtin ? "匹配范围随版本更新，这里只调整由哪些提供商抓取。" : undefined}
      footer={
        <>
          {builtin && (
            <Button className="mr-auto" variant="ghost" onClick={() => setChosen(builtin.providers)}>
              恢复默认
            </Button>
          )}
          {!builtin && stored >= 0 && (
            <Button
              className="mr-auto"
              variant="danger"
              onClick={async () => {
                if (await confirm({ title: `删除规则「${rule.name}」？`, body: "匹配的 URL 将重新按抓取工具的路由优先级处理。", confirm: "删除", danger: true })) {
                  update((draft) => void draft.routing.rules.splice(stored, 1));
                  onClose();
                }
              }}
            >
              删除
            </Button>
          )}
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!ready} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!builtin && (
          <Field label="名称" hint="出现在规则列表与报错信息中，例如站点名">
            <Input autoFocus value={name} maxLength={64} placeholder="Example Docs" onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">匹配</span>
          {builtin ? (
            <div className="num rounded-ctl border border-line bg-sunken px-2.5 py-1.5 text-xs break-all text-ink-2">{match.join(" · ")}</div>
          ) : (
            <ChipInput value={match} onChange={setMatch} normalize={cleanPattern} placeholder="example.com 或 example.com/docs/" aria-label="匹配的域名" />
          )}
          {invalid.length > 0 ? (
            <span className="text-xs text-err">{invalid.join("、")} 不是有效的域名</span>
          ) : (
            !builtin && <span className="text-xs text-ink-3">域名包含其全部子域名；加上路径前缀则只匹配该路径下的页面。可直接粘贴完整 URL。</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">提供商</span>
          <ol className="rounded-ctl border border-line">
            {lanes.map((id, index) => {
              const on = index < chosen.length;
              return (
                <li key={id} className={cx("flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0", !on && "opacity-60")}>
                  <span className={cx("num w-5 text-xs", on ? "text-signal-text" : "text-ink-3")}>{on ? String(index + 1).padStart(2, "0") : "—"}</span>
                  <span className="flex w-7 flex-col">
                    {on && (
                      <>
                        <Button size="sm" variant="ghost" className="h-4" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)} />
                        <Button size="sm" variant="ghost" className="h-4" icon={<ArrowDown />} aria-label="下移" disabled={index === chosen.length - 1} onClick={() => move(index, 1)} />
                      </>
                    )}
                  </span>
                  <span className="flex flex-1 items-center gap-2 text-sm">
                    {provider(id).name}
                    {builtin?.providers.includes(id) && <Badge tone="info">{builtin.name}</Badge>}
                    {!usable(id) && (
                      <Badge tone="warn" dot>
                        缺少密钥
                      </Badge>
                    )}
                  </span>
                  <Switch
                    checked={on}
                    onCheckedChange={(checked) => setChosen(checked ? [...chosen, id] : chosen.filter((p) => p !== id))}
                    aria-label={`由 ${provider(id).name} 抓取`}
                  />
                </li>
              );
            })}
          </ol>
          <span className="text-xs text-ink-3">只在选中的提供商中按顺序尝试，全部失败即报错，不会退回其它提供商。</span>
        </div>
        {builtin && chosen.some((id) => !builtin.providers.includes(id)) && (
          <Notice tone="warn">未标注「{builtin.name}」的提供商读不出这类页面的专有内容（例如视频字幕），由它们返回的结果会附带一条提示。</Notice>
        )}
      </div>
    </Dialog>
  );
}
