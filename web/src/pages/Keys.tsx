import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { KeyUsageDrawer } from "../components/KeyUsage";
import { ModelChain, ModelSelect } from "../components/ModelPicker";
import { api, type APIKey, type KeyPolicy, type Tool } from "../lib/api";
import { useConfig } from "../lib/config";
import { ago, compact, dateTime, toolLabel } from "../lib/format";
import { PageHeader } from "../Shell";
import { RateLimitInput } from "../ui/inputs";
import { Dialog, useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, CodeBlock, cx, Empty, Field, Input, Notice, NumberInput, Panel, Section, Segmented, Switch, Table, Td, Th } from "../ui/primitives";

/** The days the list sums the usage of each key over. */
const usageDays = 30;

const expired = (key: APIKey) => Boolean(key.expires_at && key.expires_at <= Date.now());

/** What a key's policy changes, in a few words each. */
function policyNotes(key: APIKey): string[] {
  const { extract_models, research_model, research } = key.policy;
  const notes: string[] = [];
  if (extract_models?.length || research_model) notes.push("自定义模型");
  if (research.max_steps || research.max_duration_seconds || research.max_tokens || research.quick_only || research.concurrency) notes.push("研究受限");
  if (key.expires_at && !expired(key)) notes.push(`${dateTime(key.expires_at).slice(0, 10)} 到期`);
  return notes;
}

const endpoint = () => `${window.location.origin}/mcp`;

export function KeysPage() {
  const client = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
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
        description="Agent 连接 MCP 端点所用的密钥，与登录控制台的管理员密码相互独立。每个密钥可限定可用工具、调用频率与有效期，可指定自己的模型和研究上限，并可随时吊销。"
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setForm("new")}>
            创建密钥
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <Panel flush>
          {keys.data?.length === 0 ? (
            <Empty icon={<KeyRound />} title="尚无访问密钥">
              创建密钥后，Agent 才能连接到本网关。
            </Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>名称</Th>
                  <Th>密钥</Th>
                  <Th>可用工具</Th>
                  <Th>限流</Th>
                  <Th className="whitespace-nowrap">近 {usageDays} 天</Th>
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
                    <tr key={key.id} className={cx("last:[&>td]:border-b-0", revoked && "text-ink-3")}>
                      <Td>
                        <div className="font-medium">{key.name}</div>
                        {notes.length > 0 && <div className="tag mt-0.5 normal-case">{notes.join(" · ")}</div>}
                      </Td>
                      <Td className="num text-xs">{key.prefix}…</Td>
                      <Td>
                        <span className="flex gap-1">
                          {key.scopes.map((scope) => (
                            <Badge key={scope}>{toolLabel[scope]}</Badge>
                          ))}
                        </span>
                      </Td>
                      <Td className="num text-xs">{key.rate_limit || "不限"}</Td>
                      <Td className="num text-xs whitespace-nowrap">
                        {used?.calls ? (
                          <button type="button" className="underline-offset-2 hover:underline" onClick={() => setInspected(key)}>
                            {used.calls.toLocaleString()} 次{used.input_tokens ? ` · ${compact(used.input_tokens + used.output_tokens)} Token` : ""}
                          </button>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </Td>
                      <Td className="text-xs">
                        {revoked ? <Badge tone="err">已吊销</Badge> : expired(key) ? <Badge tone="warn">已过期</Badge> : ago(key.last_used_at)}
                      </Td>
                      <Td className="num text-xs">{dateTime(key.created_at).slice(0, 10)}</Td>
                      <Td className="w-0">
                        <span className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" icon={<BarChart3 />} aria-label="用量" onClick={() => setInspected(key)} />
                          {revoked ? (
                            <Button size="sm" variant="ghost" icon={<Trash2 />} aria-label="删除" onClick={() => remove.mutate(key.id)} />
                          ) : (
                            <>
                              <Button size="sm" variant="ghost" icon={<Pencil />} aria-label="编辑" onClick={() => setForm(key)} />
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={async () => {
                                  if (await confirm({ title: `吊销「${key.name}」？`, body: "使用该密钥的 Agent 将立即失去访问权限，且无法恢复。", confirm: "吊销", danger: true })) {
                                    revoke.mutate(key.id);
                                  }
                                }}
                              >
                                吊销
                              </Button>
                            </>
                          )}
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel index="MCP" title="连接方式" description="端点使用 Streamable HTTP 传输，密钥通过 Authorization 请求头传递。">
          <ConnectionGuide secret="<你的密钥>" />
        </Panel>
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
          <Notice tone="warn">密钥仅显示一次，关闭后将无法再次查看，请妥善保存。</Notice>
          <CodeBlock copy wrap>
            {created?.secret ?? ""}
          </CodeBlock>
          <ConnectionGuide secret={created?.secret ?? ""} />
        </div>
      </Dialog>
    </>
  );
}

function ConnectionGuide({ secret }: { secret: string }) {
  const url = endpoint();
  return (
    <div className="grid gap-4">
      <Field label="Claude Code">
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
        <Field label="名称" hint="用于在日志中标识调用方，例如设备或 Agent 名称">
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
                    "flex h-8 items-center gap-2 rounded-ctl border px-3 text-sm transition-colors",
                    on ? "border-signal-text bg-signal/12 text-ink" : "border-line text-ink-3 hover:border-line-strong",
                  )}
                >
                  {toolLabel[tool]}
                  <span className="tag normal-case">{tool}</span>
                </button>
              );
            })}
          </div>
        </Field>
        {scopes.includes("dev_search") && !devSearchReady && <Notice>开发搜索尚无可用的提供商，在「工具」的「开发搜索」中启用路由并为提供商配置密钥前，该密钥无法使用此工具。</Notice>}
        {scopes.includes("research") && !config.research.enabled && <Notice>研究工具尚未启用，启用前该密钥无法使用此工具。</Notice>}
        <Field label="调用限流" hint="该密钥全部工具调用合计的频率上限">
          <RateLimitInput value={rateLimit} onChange={setRateLimit} fallback="60/m" />
        </Field>
        <Field label="有效期" hint={expiresAt ? "到期后该密钥的请求会被拒绝，可随时在此延长" : undefined}>
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
              <span className="tag normal-case">永不过期</span>
              <Button size="sm" onClick={() => setExpiresAt(Date.now() + 30 * 86_400_000)}>
                设置有效期
              </Button>
            </div>
          )}
        </Field>

        <div className="rounded-ctl border border-line [&>*:first-child]:border-t-0">
          <Section
            title="模型"
            summary={[ownChain && policy.extract_models?.length && `抽取 ${policy.extract_models.join(" → ")}`, policy.research_model && `研究 ${policy.research_model}`].filter(Boolean).join(" · ") || "按配置"}
          >
            <Field label="抓取抽取模型" hint={ownChain ? "该密钥的抓取只在这条链上故障转移；只留一个模型即不转移" : `当前配置：${config.fetch.extract.models.join(" → ") || "未关联模型"}`}>
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
              <div>
                <div className="text-sm">仅快速研究</div>
                <div className="mt-0.5 text-xs text-ink-3">每次研究都按 quick 运行，约为预算的三分之一</div>
              </div>
              <Switch checked={Boolean(limits.quick_only)} onCheckedChange={(quick_only) => limit({ quick_only })} aria-label="仅快速研究" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="步数上限">
                <NumberInput value={limits.max_steps ?? 0} onChange={(max_steps) => limit({ max_steps: Math.round(max_steps) })} suffix="步" />
              </Field>
              <Field label="时长上限">
                <NumberInput value={limits.max_duration_seconds ?? 0} onChange={(max_duration_seconds) => limit({ max_duration_seconds: Math.round(max_duration_seconds) })} suffix="秒" />
              </Field>
              <Field label="Token 上限">
                <NumberInput value={limits.max_tokens ?? 0} onChange={(max_tokens) => limit({ max_tokens: Math.round(max_tokens) })} />
              </Field>
              <Field label="同时运行">
                <NumberInput value={limits.concurrency ?? 0} onChange={(concurrency) => limit({ concurrency: Math.round(concurrency) })} suffix="个" />
              </Field>
            </div>
            <span className="text-xs text-ink-3">
              0 表示不限。上限只会压低研究配置的预算（当前 {config.research.max_steps} 步 / {config.research.max_duration_seconds} 秒 / {compact(config.research.max_tokens)} Token），不会抬高。
            </span>
          </Section>
        </div>
      </div>
    </Dialog>
  );
}
