import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type APIKey, type Tool } from "../lib/api";
import { useConfig } from "../lib/config";
import { ago, dateTime, toolLabel } from "../lib/format";
import { PageHeader } from "../Shell";
import { RateLimitInput } from "../ui/inputs";
import { Dialog, useConfirm, useToast } from "../ui/overlays";
import { Badge, Button, CodeBlock, cx, Empty, Field, Input, Notice, Panel, Table, Td, Th } from "../ui/primitives";

const endpoint = () => `${window.location.origin}/mcp`;

export function KeysPage() {
  const client = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys });
  const [form, setForm] = useState<APIKey | "new" | null>(null);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["keys"] });

  const revoke = useMutation({ mutationFn: api.revokeKey, onSuccess: refresh, onError: (e) => toast(e.message, "err") });
  const remove = useMutation({ mutationFn: api.deleteKey, onSuccess: refresh, onError: (e) => toast(e.message, "err") });

  return (
    <>
      <PageHeader
        title="访问密钥"
        description="Agent 连接 MCP 端点用的密钥，和登录本页面的管理员密码是两套体系。每把密钥可以限定可用工具和调用频率，随时吊销。"
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setForm("new")}>
            创建密钥
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <Panel flush>
          {keys.data?.length === 0 ? (
            <Empty icon={<KeyRound />} title="还没有访问密钥">
              创建一把密钥，Agent 才能连接到这个网关。
            </Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>名称</Th>
                  <Th>密钥</Th>
                  <Th>可用工具</Th>
                  <Th>限流</Th>
                  <Th>最近使用</Th>
                  <Th>创建于</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {keys.data?.map((key) => {
                  const revoked = Boolean(key.revoked_at);
                  return (
                    <tr key={key.id} className={cx("last:[&>td]:border-b-0", revoked && "text-ink-3")}>
                      <Td className="font-medium">{key.name}</Td>
                      <Td className="num text-xs">{key.prefix}…</Td>
                      <Td>
                        <span className="flex gap-1">
                          {key.scopes.map((scope) => (
                            <Badge key={scope}>{toolLabel[scope]}</Badge>
                          ))}
                        </span>
                      </Td>
                      <Td className="num text-xs">{key.rate_limit || "不限"}</Td>
                      <Td className="text-xs">{revoked ? <Badge tone="err">已吊销</Badge> : ago(key.last_used_at)}</Td>
                      <Td className="num text-xs">{dateTime(key.created_at).slice(0, 10)}</Td>
                      <Td className="w-0">
                        <span className="flex justify-end gap-1">
                          {revoked ? (
                            <Button size="sm" variant="ghost" icon={<Trash2 />} aria-label="删除" onClick={() => remove.mutate(key.id)} />
                          ) : (
                            <>
                              <Button size="sm" variant="ghost" icon={<Pencil />} aria-label="编辑" onClick={() => setForm(key)} />
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={async () => {
                                  if (await confirm({ title: `吊销「${key.name}」？`, body: "使用这把密钥的 Agent 会立即失去访问权限，且无法恢复。", confirm: "吊销", danger: true })) {
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

        <Panel index="MCP" title="连接方式" description="端点使用 Streamable HTTP 传输，密钥放在 Authorization 头里。">
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

      <Dialog open={created !== null} onOpenChange={(open) => !open && setCreated(null)} title={`密钥「${created?.name}」已创建`} width="max-w-2xl" footer={<Button variant="primary" onClick={() => setCreated(null)}>我已保存</Button>}>
        <div className="flex flex-col gap-4">
          <Notice tone="warn">密钥只显示这一次。服务端只保存它的哈希，关闭后无法再查看。</Notice>
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

  const submit = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), scopes, rate_limit: rateLimit };
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
        <Field label="名称" hint="用来在日志里区分调用方，例如设备名或 Agent 名">
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
        {scopes.includes("research") && !config.research.enabled && <Notice>研究工具目前未启用，启用之前这把密钥看不到它。</Notice>}
        <Field label="调用限流" hint="这把密钥所有工具调用合计的频率上限">
          <RateLimitInput value={rateLimit} onChange={setRateLimit} fallback="60/m" />
        </Field>
      </div>
    </Dialog>
  );
}
