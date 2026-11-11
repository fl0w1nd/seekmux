import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, BarChart3, Check, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { KeyUsageDrawer } from "../components/KeyUsage";
import { ModelChain, ModelSelect } from "../components/ModelPicker";
import { api, type APIKey, type KeyPolicy, type Tool } from "../lib/api";
import { useConfig } from "../lib/config";
import { ago, compact, dateTime, toolLabel } from "../lib/format";
import { PageHeader } from "../components/PageHeader";
import { RateLimitInput } from "../ui/inputs";
import { Dialog, useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, CodeBlock, CopyButton, cx, Empty, Field, IconButton, Info, Input, Loading, Notice, NumberInput, Panel, Section, Segmented, Status, Switch, Table, Td, Th, Tooltip } from "../ui/primitives";

/** The days the list sums the usage of each key over. */
const usageDays = 30;

const expired = (key: APIKey) => Boolean(key.expires_at && key.expires_at <= Date.now());

/** What a key's policy changes, in a few words each. */
function policyNotes(key: APIKey): string[] {
  const { extract_models, research_model, research } = key.policy;
  const notes: string[] = [];
  if (extract_models?.length || research_model) notes.push("自定义模型");
  if (research.max_steps || research.max_duration_seconds || research.max_tokens || research.quick_only || research.concurrency) notes.push("研究受限");
  return notes;
}

const endpoint = () => `${window.location.origin}/mcp`;

export function KeysPage() {
  const client = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { config } = useConfig();
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys });
  const [form, setForm] = useState<APIKey | "new" | null>(null);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [inspected, setInspected] = useState<APIKey | null>(null);
  const usage = useQuery({ queryKey: ["keys-usage"], queryFn: () => api.keysUsage(usageDays), refetchInterval: 30_000 });
  const refresh = () => client.invalidateQueries({ queryKey: ["keys"] });

  const revoke = useMutation({ mutationFn: api.revokeKey, onSuccess: refresh, onError: (e) => toast(e.message, "err") });
  const remove = useMutation({ mutationFn: api.deleteKey, onSuccess: refresh, onError: (e) => toast(e.message, "err") });

  return (
    <>
      <PageHeader
        title="访问密钥"
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setForm("new")}>
            创建密钥
          </Button>
        }
      />
      <div className="flex flex-col gap-3">
        <Panel flush>
          {!keys.data ? (
            <Loading rows={3} />
          ) : keys.data.length === 0 ? (
            <Empty size="page" icon={<KeyRound />} title="尚无访问密钥">
              <Button variant="primary" icon={<Plus />} onClick={() => setForm("new")}>
                创建密钥
              </Button>
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>名称</Th>
                    <Th>密钥</Th>
                    <Th>可用工具</Th>
                    <Th>限流</Th>
                    <Th className="text-right">近 {usageDays} 天</Th>
                    <Th>状态</Th>
                    <Th>最近使用</Th>
                    <Th>创建于</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {keys.data?.map((key) => {
                    const revoked = Boolean(key.revoked_at);
                    const used = usage.data?.keys[key.id];
                    const notes = policyNotes(key);
                    return (
                      <tr key={key.id} className={cx(revoked && "text-ink-3")}>
                        <Td>
                          <span className="flex items-center gap-2 whitespace-nowrap">
                            <span className="font-medium">{key.name}</span>
                            {notes.map((note) => (
                              <Badge key={note}>{note}</Badge>
                            ))}
                          </span>
                        </Td>
                        <Td className="num text-xs whitespace-nowrap">{key.oauth_client ? <Badge tone="info">OAuth</Badge> : `${key.prefix}…`}</Td>
                        <Td className={cx("text-xs whitespace-nowrap", !revoked && "text-ink-2")}>{key.scopes.map((scope) => toolLabel[scope]).join(" · ")}</Td>
                        <Td className={cx("num text-xs whitespace-nowrap", !key.rate_limit && "font-sans text-ink-3")}>{key.rate_limit || "不限"}</Td>
                        <Td className="num text-right text-xs whitespace-nowrap">
                          {used?.calls ? (
                            <Tooltip content={used.input_tokens ? `${compact(used.input_tokens + used.output_tokens)} Token` : "查看用量"}>
                              <button type="button" className="underline-offset-2 hover:underline" onClick={() => setInspected(key)}>
                                {used.calls.toLocaleString()}
                                <span className="ml-1 font-sans text-ink-3">次</span>
                              </button>
                            </Tooltip>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </Td>
                        <Td className="whitespace-nowrap">
                          <KeyState apiKey={key} />
                        </Td>
                        <Td className={cx("text-xs whitespace-nowrap", !revoked && "text-ink-2")}>{ago(key.last_used_at)}</Td>
                        <Td className="num text-xs whitespace-nowrap text-ink-3">{dateTime(key.created_at).slice(0, 10)}</Td>
                        <Td className="w-0">
                          <span className="flex justify-end gap-0.5">
                            <IconButton size="sm" icon={<BarChart3 />} label="用量" onClick={() => setInspected(key)} />
                            {revoked ? (
                              <IconButton
                                size="sm"
                                icon={<Trash2 />}
                                label="删除"
                                className="hover:bg-err/10 hover:text-err"
                                onClick={() => remove.mutate(key.id)}
                              />
                            ) : (
                              <>
                                <IconButton size="sm" icon={<Pencil />} label="编辑" onClick={() => setForm(key)} />
                                <IconButton
                                  size="sm"
                                  icon={<Ban />}
                                  label="吊销"
                                  className="hover:bg-err/10 hover:text-err"
                                  onClick={async () => {
                                    if (
                                      await confirm({
                                        title: `吊销「${key.name}」？`,
                                        body: key.oauth_client ? "该客户端的令牌立即失效，再次接入需要重新登录授权。" : "使用该密钥的 Agent 将立即失去访问权限，且无法恢复。",
                                        confirm: "吊销",
                                        danger: true,
                                      })
                                    ) {
                                      revoke.mutate(key.id);
                                    }
                                  }}
                                />
                              </>
                            )}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          )}
        </Panel>

        <Connect oauth={!config.oauth.disabled} />
      </div>

      {form && (
        <KeyDialog
          initial={form === "new" ? null : form}
          onClose={() => setForm(null)}
          onCreated={(name, secret) => {
            setForm(null);
            setCreated({ name, secret });
            void refresh();
          }}
          onUpdated={() => {
            setForm(null);
            void refresh();
          }}
        />
      )}

      <KeyUsageDrawer apiKey={inspected} onClose={() => setInspected(null)} />

      <Dialog open={created !== null} onOpenChange={(open) => !open && setCreated(null)} title={`密钥「${created?.name}」已创建`} width="max-w-2xl" footer={<Button variant="primary" onClick={() => setCreated(null)}>完成</Button>}>
        <div className="flex flex-col gap-4">
          <Notice tone="warn">密钥只显示这一次。</Notice>
          <CodeBlock copy wrap>
            {created?.secret ?? ""}
          </CodeBlock>
          <ConnectionGuide secret={created?.secret ?? ""} />
        </div>
      </Dialog>
    </>
  );
}

/** Whether a key works: revoked and expired are problems; a key that will expire says when. */
function KeyState({ apiKey: key }: { apiKey: APIKey }) {
  if (key.revoked_at) return <Badge tone="err" dot>已吊销</Badge>;
  if (expired(key)) return <Badge tone="warn" dot>已过期</Badge>;
  if (key.expires_at) return <Status tone="ok">{dateTime(key.expires_at).slice(0, 10)} 到期</Status>;
  return <Status tone="ok">有效</Status>;
}

type Method = "oauth" | "key" | "json";

/** How a client connects: the endpoint, and one way to add it at a time. */
function Connect({ oauth }: { oauth: boolean }) {
  const url = endpoint();
  const [picked, setPicked] = useState<Method>(oauth ? "oauth" : "key");
  const method = !oauth && picked === "oauth" ? "key" : picked;
  const methods: { value: Method; label: string }[] = [
    ...(oauth ? [{ value: "oauth" as const, label: "Claude Code · OAuth" }] : []),
    { value: "key", label: "Claude Code · 密钥" },
    { value: "json", label: "通用 JSON" },
  ];
  const code = {
    oauth: `claude mcp add --transport http seekmux ${url}`,
    key: `claude mcp add --transport http seekmux ${url} --header "Authorization: Bearer <你的密钥>"`,
    json: JSON.stringify({ mcpServers: { seekmux: { type: "http", url, headers: { Authorization: "Bearer <你的密钥>" } } } }, null, 2),
  }[method];

  return (
    <Panel title="连接方式" flush>
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5">
        <span className="tag w-16 shrink-0">MCP 地址</span>
        <span className="num min-w-0 flex-1 truncate text-sm">{url}</span>
        <CopyButton text={url} label="复制" />
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="max-w-full overflow-x-auto">
          <Segmented size="sm" value={method} onChange={setPicked} options={methods} />
        </div>
        <CodeBlock copy wrap={method !== "json"}>
          {code}
        </CodeBlock>
        {method === "oauth" && <span className="text-xs text-ink-3">首次连接时在浏览器授权</span>}
      </div>
    </Panel>
  );
}

function ConnectionGuide({ secret }: { secret: string }) {
  const url = endpoint();
  return (
    <div className="grid gap-4">
      <Field label="Claude Code · 密钥">
        <CodeBlock copy wrap>{`claude mcp add --transport http seekmux ${url} --header "Authorization: Bearer ${secret}"`}</CodeBlock>
      </Field>
      <Field label="通用 MCP 配置（JSON）">
        <CodeBlock copy>
          {JSON.stringify({ mcpServers: { seekmux: { type: "http", url, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2)}
        </CodeBlock>
      </Field>
    </div>
  );
}

function KeyDialog({
  initial,
  onClose,
  onCreated,
  onUpdated,
}: {
  initial: APIKey | null;
  onClose: () => void;
  onCreated: (name: string, secret: string) => void;
  onUpdated: () => void;
}) {
  const { meta, config } = useConfig();
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [scopes, setScopes] = useState<Tool[]>(initial?.scopes ?? ["search", "fetch"]);
  const [rateLimit, setRateLimit] = useState(initial?.rate_limit ?? "");
  const [expiresAt, setExpiresAt] = useState(initial?.expires_at ?? 0);
  const [policy, setPolicy] = useState<KeyPolicy>(initial?.policy ?? { research: {} });
  // An empty chain of one's own is the configured chain, so the choice is kept apart.
  const [ownChain, setOwnChain] = useState(Boolean(initial?.policy.extract_models?.length));
  const limits = policy.research;
  const limit = (patch: Partial<KeyPolicy["research"]>) => setPolicy({ ...policy, research: { ...limits, ...patch } });
  const bounds = [
    limits.quick_only && "仅快速",
    limits.max_steps && `${limits.max_steps} 步`,
    limits.max_duration_seconds && `${limits.max_duration_seconds} 秒`,
    limits.max_tokens && `${compact(limits.max_tokens)} Token`,
    limits.concurrency && `同时 ${limits.concurrency} 个`,
  ].filter(Boolean);

  const devSearchReady = config.dev_search.routes.some((route) => {
    const creds = config.providers[route.provider];
    return route.enabled && Boolean(creds?.api_key || (creds?.api_key_hint && !creds.clear_api_key));
  });

  // As the gateway decides it (Config.SocialAvailable): the source is on and names a worker that is switched on.
  const xSource = config.social.sources.find((s) => s.platform === "x");
  const xReady = Boolean(
    xSource?.enabled && config.fetchers.find((f) => f.id === xSource.fetcher)?.workers.some((w) => w.enabled && xSource.workers.includes(w.id)),
  );

  const submit = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        scopes,
        rate_limit: rateLimit,
        expires_at: expiresAt,
        policy: { ...policy, extract_models: ownChain ? policy.extract_models : [] },
      };
      if (initial) {
        await api.updateKey(initial.id, body);
        onUpdated();
      } else {
        const res = await api.createKey(body);
        onCreated(res.key.name, res.secret);
      }
    },
    onError: (e) => toast(e.message, "err"),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={initial ? "编辑密钥" : "创建访问密钥"}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={submit.isPending} disabled={!name.trim() || scopes.length === 0} onClick={() => submit.mutate()}>
            {initial ? "保存" : "创建"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="名称">
          <Input autoFocus value={name} maxLength={64} placeholder="macbook · claude code" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="可用工具">
          <div className="flex flex-wrap gap-2">
            {meta.tools.map((tool) => {
              const on = scopes.includes(tool);
              return (
                <button
                  key={tool}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setScopes(on ? scopes.filter((s) => s !== tool) : [...scopes, tool])}
                  className={cx(
                    "press flex h-8 items-center gap-1.5 rounded-ctl px-3 text-sm",
                    on ? "bg-signal/25 text-ink hover:bg-signal/35" : "bg-fill text-ink-2 hover:bg-fill-strong hover:text-ink",
                  )}
                >
                  {on && <Check className="-ml-0.5 size-3.5 text-signal-ink" />}
                  {toolLabel[tool]}
                  <span className="num text-2xs text-ink-3">{tool}</span>
                </button>
              );
            })}
          </div>
        </Field>
        {scopes.includes("dev_search") && !devSearchReady && <Notice tone="warn">开发搜索暂无可用的提供商，该密钥暂时无法调用。</Notice>}
        {scopes.includes("x_search") && !xReady && <Notice tone="warn">X 搜索未添加或未选择 Worker，该密钥暂时无法调用。</Notice>}
        {scopes.includes("research") && !config.research.enabled && <Notice tone="warn">深度研究未启用，该密钥暂时无法调用。</Notice>}
        <Field label="调用限流" info="该密钥所有工具调用合计">
          <RateLimitInput value={rateLimit} onChange={setRateLimit} fallback="60/m" />
        </Field>
        <Field label="有效期">
          {expiresAt ? (
            <div className="flex items-center gap-1.5">
              <Input
                mono
                type="datetime-local"
                className="w-56"
                aria-label="到期时间"
                value={dateTime(expiresAt).slice(0, 16).replace(" ", "T")}
                onChange={(e) => e.target.value && setExpiresAt(new Date(e.target.value).getTime())}
              />
              <Button size="sm" variant="ghost" onClick={() => setExpiresAt(0)}>
                永不过期
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-3">永不过期</span>
              <Button size="sm" onClick={() => setExpiresAt(Date.now() + 30 * 86_400_000)}>
                设置有效期
              </Button>
            </div>
          )}
        </Field>

        <div className="rounded-ctl border border-line [&>*:first-child]:border-t-0">
          <Section
            title="模型"
            summary={[ownChain && policy.extract_models?.length && `提取 ${policy.extract_models.join(" → ")}`, policy.research_model && `研究 ${policy.research_model}`].filter(Boolean).join(" · ") || "按配置"}
          >
            <Field label="提取模型" hint={ownChain ? undefined : `当前配置：${config.fetch.extract.models.join(" → ") || "未关联模型"}`}>
              <div className="flex flex-col gap-2">
                <div>
                  <Segmented
                    size="sm"
                    value={ownChain ? "own" : "default"}
                    onChange={(value) => setOwnChain(value === "own")}
                    options={[
                      { value: "default", label: "按配置" },
                      { value: "own", label: "自定义" },
                    ]}
                  />
                </div>
                {ownChain && <ModelChain value={policy.extract_models ?? []} onChange={(ids) => setPolicy({ ...policy, extract_models: ids })} />}
              </div>
            </Field>
            <Field label="研究模型" hint={`当前配置：${config.research.model || "未选择"}`}>
              <ModelSelect empty="按配置" value={policy.research_model ?? ""} onChange={(id) => setPolicy({ ...policy, research_model: id })} />
            </Field>
          </Section>
          <Section title="研究限制" summary={bounds.join(" · ") || "按配置"}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-1 text-sm">
                仅快速研究
                <Info>每次研究都按 quick 运行，预算约为 1/3</Info>
              </div>
              <Switch checked={Boolean(limits.quick_only)} onCheckedChange={(quick_only) => limit({ quick_only })} aria-label="仅快速研究" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="步数上限" hint={above(limits.max_steps, config.research.max_steps) && `按全局 ${config.research.max_steps} 步`}>
                <NumberInput value={limits.max_steps ?? 0} onChange={(max_steps) => limit({ max_steps: Math.round(max_steps) })} suffix="步" zero={`全局 ${config.research.max_steps} 步`} />
              </Field>
              <Field label="时长上限" hint={above(limits.max_duration_seconds, config.research.max_duration_seconds) && `按全局 ${config.research.max_duration_seconds} 秒`}>
                <NumberInput value={limits.max_duration_seconds ?? 0} onChange={(max_duration_seconds) => limit({ max_duration_seconds: Math.round(max_duration_seconds) })} suffix="秒" zero={`全局 ${config.research.max_duration_seconds} 秒`} />
              </Field>
              <Field label="Token 上限" hint={above(limits.max_tokens, config.research.max_tokens) && `按全局 ${compact(config.research.max_tokens)}`}>
                <NumberInput value={limits.max_tokens ?? 0} onChange={(max_tokens) => limit({ max_tokens: Math.round(max_tokens) })} zero={`全局 ${compact(config.research.max_tokens)}`} />
              </Field>
              <Field label="同时运行">
                <NumberInput value={limits.concurrency ?? 0} onChange={(concurrency) => limit({ concurrency: Math.round(concurrency) })} suffix="个" zero="不限" />
              </Field>
            </div>
          </Section>
        </div>
      </div>
    </Dialog>
  );
}

/** Whether a key's ceiling is above the global one, which then applies instead. */
function above(own: number | undefined, global: number): boolean {
  return (own ?? 0) > global;
}
