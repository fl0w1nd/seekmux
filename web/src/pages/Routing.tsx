import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Radar } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, Redirect, useLocation, useParams } from "wouter";
import { api, type Config, type DomainProviderStats, type DomainStats, type FetchOutcome, type Rule } from "../lib/api";
import { useConfig } from "../lib/config";
import { bytes, duration, percent } from "../lib/format";
import { cleanPattern, newRuleID, routingRules, ruleForDomain, validPattern } from "../lib/routing";
import { PageHeader } from "../Shell";
import { BrandIcon } from "../ui/brand";
import { ChipInput } from "../ui/inputs";
import { Dialog, useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, cx, Empty, Field, Input, Notice, Panel, Segmented, Spinner, Switch, Table, TabList, TabPanel, Tabs, Td, Th } from "../ui/primitives";

const tabs = [
  { value: "rules", label: "规则" },
  { value: "domains", label: "域名统计" },
];

/** Whether a provider can be called: it has an API key or needs none. */
function useCredentials() {
  const { config, provider } = useConfig();
  return (id: string) => {
    const creds = config.providers[id];
    return !provider(id).key_required || Boolean(creds?.api_key || (creds?.api_key_hint && !creds.clear_api_key));
  };
}

/** Which providers read which pages, and how each provider fares on every domain. */
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
        description="按 URL 决定由哪些提供商抓取：有些页面只有个别提供商能读出内容。域名统计显示各提供商在每个域名上的实际表现，可据此新增规则。"
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
          {tab === "rules" ? (
            <Rules onEdit={setForm} />
          ) : (
            <Domains
              onRoute={(rule) => {
                setForm(rule);
                navigate("/routing/rules");
              }}
            />
          )}
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
              <span className={cx("flex w-7 flex-col", rule.builtin && "max-sm:hidden")}>
                {!rule.builtin && (
                  <>
                    <Button size="sm" variant="ghost" className="h-4" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)} />
                    <Button size="sm" variant="ghost" className="h-4" icon={<ArrowDown />} aria-label="下移" disabled={index === own - 1} onClick={() => move(index, 1)} />
                  </>
                )}
              </span>
              <div className="min-w-48 flex-1 max-sm:basis-[calc(100%-3rem)]">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {rule.builtin && <BrandIcon id={rule.id} className="size-4" />}
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
              <div className="flex flex-col gap-1 text-right max-sm:order-1 max-sm:mr-auto max-sm:ml-10 max-sm:text-left">
                <span className="tag">提供商</span>
                <span className="flex flex-wrap items-center justify-end gap-1.5 text-xs text-ink-2 max-sm:justify-start">
                  {rule.providers.map((id, i) => (
                    <Fragment key={id}>
                      {i > 0 && <span className="text-ink-3">→</span>}
                      <BrandIcon id={id} className="size-3.5" />
                      {provider(id).name}
                    </Fragment>
                  ))}
                </span>
              </div>
              <Button size="sm" variant="ghost" className="max-sm:order-2" icon={<Pencil />} onClick={() => onEdit(rule)}>
                编辑
              </Button>
              <span className="flex max-sm:order-2">
                <Switch checked={rule.enabled} onCheckedChange={(enabled) => enable(rule, index, enabled)} aria-label={`启用规则 ${rule.name}`} />
              </span>
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
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <BrandIcon id={id} className="size-4" />
                    {provider(id).name}
                    {builtin?.providers.includes(id) && (
                      <Badge tone="info">
                        <BrandIcon id={builtin.id} className="size-3" />
                        {builtin.name}
                      </Badge>
                    )}
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

const outcomes: { key: Exclude<FetchOutcome, "ok">; label: string }[] = [
  { key: "blocked", label: "被拦截" },
  { key: "missing", label: "不存在" },
  { key: "failed", label: "失败" },
  { key: "timeout", label: "超时" },
];

/** The share of pages read among those the site has: a missing page is the link's fault. */
function success(stats: { calls: number; outcomes: DomainStats["outcomes"] }) {
  const settled = stats.calls - (stats.outcomes.missing ?? 0);
  return { text: percent(stats.outcomes.ok ?? 0, settled), bad: settled > 0 && (stats.outcomes.ok ?? 0) / settled < 0.5 };
}

function Counts({ stats }: { stats: { calls: number; outcomes: DomainStats["outcomes"] } }) {
  const rate = success(stats);
  return (
    <>
      <Td className="num text-right text-xs">{stats.calls}</Td>
      <Td className={cx("num text-right text-xs", rate.bad && "text-err")}>{rate.text}</Td>
      {outcomes.map(({ key }) => (
        <Td key={key} className={cx("num text-right text-xs", !stats.outcomes[key] && "text-ink-3")}>
          {stats.outcomes[key] ?? 0}
        </Td>
      ))}
    </>
  );
}

type Days = "7" | "30" | "90";

function Domains({ onRoute }: { onRoute: (rule: Rule) => void }) {
  const { config, meta, provider } = useConfig();
  const client = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [days, setDays] = useState<Days>("7");
  const [only, setOnly] = useState<"all" | "trouble">("all");
  const [open, setOpen] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["domains", days], queryFn: () => api.domains(Number(days)), refetchInterval: 10_000, placeholderData: (previous) => previous });
  const clear = useMutation({ mutationFn: api.clearDomains, onSuccess: () => client.invalidateQueries({ queryKey: ["domains"] }), onError: (e) => toast(e.message, "err") });

  const rules = routingRules(config, meta);
  const all = query.data?.domains ?? [];
  const troubled = (d: DomainStats) => outcomes.some(({ key }) => key !== "missing" && (d.outcomes[key] ?? 0) > 0);
  const rows = only === "trouble" ? all.filter(troubled) : all;

  /** A rule for the domain, led by the providers that read its pages most often. */
  const suggest = (d: DomainStats): Rule => ({
    id: newRuleID(),
    name: d.domain,
    enabled: true,
    match: [d.domain],
    providers: d.providers
      .filter((p) => (p.outcomes.ok ?? 0) > 0)
      .sort((a, b) => (b.outcomes.ok ?? 0) - (a.outcomes.ok ?? 0))
      .map((p) => p.provider),
  });

  return (
    <Panel
      index="01"
      title="域名统计"
      description={`各提供商在每个域名上的抓取结果，保留 ${query.data?.retention_days ?? 90} 天。「成功」只表示提供商返回了正文，不代表内容完整：同一域名下正文明显偏短的提供商，可能只拿到了页面外壳。缓存命中、对冲中被取消的请求和提供商自身的故障不计入。`}
      actions={
        <>
          <Segmented
            size="sm"
            value={only}
            onChange={setOnly}
            options={[
              { value: "all", label: "全部" },
              { value: "trouble", label: "有失败" },
            ]}
          />
          <Segmented
            size="sm"
            value={days}
            onChange={setDays}
            options={[
              { value: "7", label: "7 天" },
              { value: "30", label: "30 天" },
              { value: "90", label: "90 天" },
            ]}
          />
          <Button
            size="sm"
            variant="danger"
            disabled={all.length === 0}
            onClick={async () => {
              if (await confirm({ title: "清空域名统计？", body: "全部域名的统计将被删除，且无法恢复。路由规则不受影响。", confirm: "清空", danger: true })) clear.mutate();
            }}
          >
            清空
          </Button>
        </>
      }
      flush
    >
      {!query.data ? (
        <div className="grid place-items-center py-16">{query.error ? <span className="text-sm text-err">{query.error.message}</span> : <Spinner />}</div>
      ) : rows.length === 0 ? (
        <Empty icon={<Radar />} title={all.length === 0 ? "尚无统计" : "所选时间内没有抓取失败的域名"}>
          {all.length === 0 && "通过 fetch 工具抓取页面后，这里按域名列出各提供商的成功与失败。"}
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>域名 / 提供商</Th>
                <Th className="text-right">调用</Th>
                <Th className="text-right">成功率</Th>
                {outcomes.map(({ key, label }) => (
                  <Th key={key} className="text-right">
                    {label}
                  </Th>
                ))}
                <Th className="text-right">平均耗时</Th>
                <Th className="text-right">平均正文</Th>
                <Th className="text-right">路由</Th>
              </tr>
            </thead>
            <tbody className="[&>tr:last-child>td]:border-b-0">
              {rows.map((d) => {
                const rule = ruleForDomain(rules, d.domain);
                const expanded = open === d.domain;
                const longest = Math.max(0, ...d.providers.filter((p) => p.outcomes.ok).map((p) => p.avg_bytes));
                return (
                  <Fragment key={d.domain}>
                    <tr className="cursor-pointer hover:bg-raised/60" onClick={() => setOpen(expanded ? null : d.domain)}>
                      <Td>
                        <button type="button" aria-expanded={expanded} className="num flex items-center gap-1.5 text-sm">
                          {expanded ? <ChevronDown className="size-3.5 text-ink-3" /> : <ChevronRight className="size-3.5 text-ink-3" />}
                          {d.domain}
                        </button>
                      </Td>
                      <Counts stats={d} />
                      <Td className="num text-right text-xs text-ink-3">—</Td>
                      <Td className="num text-right text-xs text-ink-3">—</Td>
                      <Td className="w-0 text-right" onClick={(e) => e.stopPropagation()}>
                        {rule ? (
                          <Link href="/routing/rules">
                            <Badge tone="info">
                              {rule.builtin && <BrandIcon id={rule.id} className="size-3" />}
                              {rule.name}
                            </Badge>
                          </Link>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => onRoute(suggest(d))}>
                            建规则
                          </Button>
                        )}
                      </Td>
                    </tr>
                    {expanded && d.providers.map((p) => <ProviderRow key={p.provider} stats={p} name={provider(p.provider).name} longest={longest} />)}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

function ProviderRow({ stats, name, longest }: { stats: DomainProviderStats; name: string; longest: number }) {
  const read = (stats.outcomes.ok ?? 0) > 0;
  // Far less text than another provider gets from the same site.
  const short = read && stats.avg_bytes < longest * 0.3;
  return (
    <tr className="bg-sunken/60">
      <Td className="pl-9! text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <BrandIcon id={stats.provider} className="size-3.5" />
          {name}
        </span>
      </Td>
      <Counts stats={stats} />
      <Td className="num text-right text-xs">{read ? duration(stats.avg_ms) : "—"}</Td>
      <Td className="num text-right text-xs">{read ? bytes(stats.avg_bytes) : "—"}</Td>
      <Td className="text-right">{short && <Badge tone="warn">正文偏短</Badge>}</Td>
    </tr>
  );
}
