import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Radar } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, Redirect, useLocation, useParams } from "wouter";
import { api, type Config, type DomainProviderStats, type DomainStats, type FetchOutcome, type Rule } from "../lib/api";
import { missing, ProviderIcon } from "../components/ProviderName";
import { useConfig } from "../lib/config";
import { routingPages } from "../lib/pages";
import { bytes, duration, percent } from "../lib/format";
import { cleanPattern, newRuleID, routingRules, ruleForDomain, validPattern } from "../lib/routing";
import { PageHeader } from "../components/PageHeader";
import { BrandIcon } from "../ui/brand";
import { ChipInput } from "../ui/inputs";
import { Dialog, useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, cx, Empty, Field, Input, Loading, Panel, Segmented, Status, Switch, Table, Td, Th, Tooltip } from "../ui/primitives";

/** Whether a provider can be called: it has an API key or needs none; a fetcher has a worker switched on. */
function useCredentials() {
  return useConfig().credentialed;
}

/** Which providers read which pages, and how each provider fares on every domain. */
export function RoutingPage() {
  const { tab } = useParams<{ tab: string }>();
  const [, navigate] = useLocation();
  // The rule in the dialog; one the configuration does not hold yet is new.
  const [form, setForm] = useState<Rule | null>(null);
  const current = routingPages.find((t) => t.value === tab);
  if (!current) return <Redirect to="/routing/rules" replace />;

  return (
    <>
      <PageHeader
        section="服务路由"
        title={current.label}
        actions={
          tab === "rules" && (
            <Button variant="primary" icon={<Plus />} onClick={() => setForm({ id: newRuleID(), name: "", enabled: true, match: [], providers: [] })}>
              新建规则
            </Button>
          )
        }
      />
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
      {form && <RuleDialog rule={form} onClose={() => setForm(null)} />}
    </>
  );
}

/** Stores a built-in rule's settings, dropping an unused entry. */
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
  const enable = (rule: Rule, index: number, enabled: boolean) => {
    if (enabled && rule.providers.length === 0) {
      onEdit({ ...rule, enabled: true });
      return;
    }
    update((draft) => {
      if (rule.builtin) changeBuiltin(draft, rule.id, { enabled });
      else draft.routing.rules[index].enabled = enabled;
    });
  };

  return (
    <Panel
      title="匹配顺序"
      info="自上而下匹配，命中即停。命中的 URL 只由规则的提供商抓取，调用方用 fetch_engine 指定时除外。"
      flush
    >
      <div className="hidden h-9 items-center gap-3 border-b border-line px-4 lg:flex">
        <span className={cx("tag shrink-0", own > 1 ? "w-16" : "w-6")}>#</span>
        <span className="tag w-56 shrink-0">规则</span>
        <span className="tag flex-1">匹配域名</span>
        <span className="tag w-52 shrink-0">提供商</span>
        <span className="tag w-24 shrink-0 text-right">操作</span>
      </div>
      <ol>
        {rules.map((rule, index) => {
          const ready = rule.providers.some(usable);
          const patterns = rule.match.join(" · ");
          return (
            <li
              key={rule.id}
              className={cx(
                "flex min-h-13 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2.5 transition-colors last:border-b-0 hover:bg-fill lg:flex-nowrap",
                !rule.enabled && "opacity-60",
              )}
            >
              <span className={cx("num w-6 shrink-0 text-xs", rule.enabled && ready ? "text-ink-2" : "text-ink-3")}>{String(index + 1).padStart(2, "0")}</span>
              {own > 1 && (
                <span className={cx("flex w-7 shrink-0 flex-col", rule.builtin && "max-sm:hidden")}>
                  {!rule.builtin && (
                    <>
                      <Button size="sm" variant="ghost" className="h-4" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)} />
                      <Button size="sm" variant="ghost" className="h-4" icon={<ArrowDown />} aria-label="下移" disabled={index === own - 1} onClick={() => move(index, 1)} />
                    </>
                  )}
                </span>
              )}
              <div className="flex min-w-44 shrink-0 flex-wrap items-center gap-1.5 text-sm font-medium max-lg:flex-1 lg:w-56">
                {rule.builtin && <BrandIcon id={rule.id} className="size-4 shrink-0" />}
                <span className="truncate">{rule.name}</span>
                {(rule.builtin || !rule.enabled) && (
                  <span className="text-xs font-normal text-ink-3">{[rule.builtin && "内置", !rule.enabled && "已停用"].filter(Boolean).join(" · ")}</span>
                )}
                {!rule.enabled ? null : ready ? (
                  <Status tone="ok" className="font-normal">
                    生效
                  </Status>
                ) : (
                  <Link href={missing(provider(rule.providers[0] ?? "")).href}>
                    <Badge tone="warn" dot>
                      {rule.providers.length > 0 && rule.providers.every((id) => provider(id).fetcher) ? "未启用 Worker" : "缺少密钥"}
                    </Badge>
                  </Link>
                )}
              </div>
              <div className="num min-w-0 flex-1 truncate text-xs text-ink-3 max-lg:order-3 max-lg:basis-full max-lg:pl-9" title={patterns}>
                {patterns}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-ink-2 max-lg:order-4 max-lg:mr-auto max-lg:pl-9 lg:w-52">
                {rule.providers.length === 0 && <span className="text-ink-3">未配置</span>}
                {rule.providers.map((id, i) => (
                  <Fragment key={id}>
                    {i > 0 && <span className="text-ink-3">→</span>}
                    <ProviderIcon id={id} className="size-3.5 shrink-0" />
                    <span className="truncate">{provider(id).name}</span>
                  </Fragment>
                ))}
              </div>
              <div className="ml-auto flex shrink-0 items-center justify-end gap-2 lg:ml-0 lg:w-24">
                <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => onEdit(rule)}>
                  编辑
                </Button>
                <Switch checked={rule.enabled} onCheckedChange={(enabled) => enable(rule, index, enabled)} aria-label={`启用规则 ${rule.name}`} />
              </div>
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
  const fetchers = [...meta.catalog.filter((info) => info.tools.includes("fetch")).map((info) => info.id), ...config.fetchers.map((f) => f.id)];
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
        changeBuiltin(draft, builtin.id, { enabled: rule.enabled, providers: chosen });
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
      footer={
        <>
          {!builtin && stored >= 0 && (
            <Button
              className="mr-auto"
              variant="danger"
              onClick={async () => {
                if (await confirm({ title: `删除规则「${rule.name}」？`, body: "匹配的 URL 改按抓取路由处理。", confirm: "删除", danger: true })) {
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
          <Field label="名称">
            <Input autoFocus value={name} maxLength={64} placeholder="Example Docs" onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">匹配</span>
          {builtin ? (
            <div className="num rounded-ctl bg-sunken px-2.5 py-2 text-xs break-all text-ink-2">{match.join(" · ")}</div>
          ) : (
            <ChipInput value={match} onChange={setMatch} normalize={cleanPattern} placeholder="example.com 或 example.com/docs/" aria-label="匹配的域名" />
          )}
          {invalid.length > 0 ? (
            <span className="text-xs text-err">{invalid.join("、")} 不是有效的域名</span>
          ) : (
            !builtin && <span className="text-xs text-ink-3">含子域名</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">提供商</span>
          <ol className="rounded-ctl border border-line">
            {lanes.map((id, index) => {
              const on = index < chosen.length;
              return (
                <li key={id} className={cx("flex min-h-11 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0", !on && "opacity-60")}>
                  <span className={cx("num w-5 text-xs", on ? "text-ink-2" : "text-ink-3")}>{on ? String(index + 1).padStart(2, "0") : "—"}</span>
                  {chosen.length > 1 && (
                    <span className="flex w-7 flex-col">
                      {on && (
                        <>
                          <Button size="sm" variant="ghost" className="h-4" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)} />
                          <Button size="sm" variant="ghost" className="h-4" icon={<ArrowDown />} aria-label="下移" disabled={index === chosen.length - 1} onClick={() => move(index, 1)} />
                        </>
                      )}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <ProviderIcon id={id} className="size-4" />
                    {provider(id).name}
                    {!usable(id) && (
                      <Badge tone="warn" dot>
                        {missing(provider(id)).label}
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
          <span className="text-xs text-ink-3">按顺序尝试，全部失败即报错，不回退</span>
        </div>
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
      title="抓取结果"
      info={`保留 ${query.data?.retention_days ?? 90} 天，不含缓存命中与取消的请求`}
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
              if (await confirm({ title: "清空域名统计？", body: "此操作不可撤销。", confirm: "清空", danger: true })) clear.mutate();
            }}
          >
            清空
          </Button>
        </>
      }
      flush
    >
      {!query.data ? (
        query.error ? <div className="grid place-items-center py-16 text-sm text-err">{query.error.message}</div> : <Loading rows={6} />
      ) : rows.length === 0 ? (
        <Empty icon={<Radar />} title={all.length === 0 ? "尚无统计" : "所选时间内没有抓取失败的域名"} />
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
                    <tr className="cursor-pointer transition-colors hover:bg-fill" onClick={() => setOpen(expanded ? null : d.domain)}>
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
    <tr className="bg-sunken">
      <Td className="pl-9! text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <ProviderIcon id={stats.provider} className="size-3.5" />
          {name}
        </span>
      </Td>
      <Counts stats={stats} />
      <Td className="num text-right text-xs">{read ? duration(stats.avg_ms) : "—"}</Td>
      <Td className="num text-right text-xs">{read ? bytes(stats.avg_bytes) : "—"}</Td>
      <Td className="text-right">
        {short && (
          <Tooltip content="平均正文长度不足同域名最高值的 30%">
            <span>
              <Badge tone="warn">正文偏短</Badge>
            </span>
          </Tooltip>
        )}
      </Td>
    </tr>
  );
}
