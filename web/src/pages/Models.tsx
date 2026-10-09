import { Bot, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { api, type Config, type LLMProvider, type LLMType, type Model, type Reasoning } from "../lib/api";
import { Tripped, useStatus } from "../components/Health";
import { useConfig } from "../lib/config";
import { compact, duration } from "../lib/format";
import { PageHeader } from "../Shell";
import { JSONInput, RateLimitInput, SecretInput } from "../ui/inputs";
import { Dialog, useConfirm } from "../ui/overlays";
import { Badge, Button, Empty, Field, Input, Notice, NumberInput, Panel, Segmented, Select, Table, Td, Th, Tooltip } from "../ui/primitives";

const typeLabel: Record<LLMType, string> = { "openai-compatible": "OpenAI 兼容", anthropic: "Anthropic" };

const blankProvider: LLMProvider = { id: "", name: "", type: "openai-compatible", base_url: "", api_key: "", models: [] };
const blankModel: Model = { id: "", name: "", reasoning: { mode: "" }, rate_limit: "", concurrency: 0 };

/** The features a model is assigned to. */
function rolesOf(config: Config, id: string): string[] {
  const position = config.fetch.extract.models.indexOf(id);
  return [...(position === 0 ? ["提取 · 首选"] : position > 0 ? [`提取 · 备用 ${position}`] : []), ...(config.research.model === id ? ["研究"] : [])];
}

/** Derives a model id from the model name the same way the server does. */
const toModelID = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);

function reasoningLabel(r: Reasoning): string {
  switch (r.mode) {
    case "off":
      return "关闭";
    case "effort":
      return `强度 · ${r.effort}`;
    case "budget":
      return `预算 · ${compact(r.budget_tokens ?? 0)}`;
    default:
      return "模型默认";
  }
}

type Editing = { kind: "provider"; index: number } | { kind: "model"; provider: number; index: number } | null;

export function ModelsPage() {
  const { config, update } = useConfig();
  const status = useStatus();
  const confirm = useConfirm();
  const providers = config.llm.providers;
  // An index of -1 means a new entry.
  const [editing, setEditing] = useState<Editing>(null);
  const modelIDs = providers.flatMap((p) => p.models.map((m) => m.id));

  return (
    <>
      <PageHeader
        title="模型接口"
        description="大模型的接口和接口下的模型。模型在这里有自己的身份：参数、限流都跟着模型走，「抓取」和「深度研究」只按 ID 引用它，共用同一个模型时也共用它的限流。"
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ kind: "provider", index: -1 })}>
            添加接口
          </Button>
        }
      />

      {providers.length === 0 ? (
        <Panel>
          <Empty icon={<Bot />} title="还没有模型接口">
            添加一个 OpenAI 兼容或 Anthropic 格式的接口，再在它下面登记模型。之后 fetch 才能用模型提炼页面，研究工具才能运行。
          </Empty>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {providers.map((p, pi) => {
            const inUse = p.models.some((m) => rolesOf(config, m.id).length > 0);
            return (
              <Panel
                key={p.id}
                flush
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {p.name || p.id}
                    <Badge>{typeLabel[p.type]}</Badge>
                    {!p.api_key && !(p.api_key_hint && !p.clear_api_key) && (
                      <Badge tone="warn" dot>
                        未设置密钥
                      </Badge>
                    )}
                  </span>
                }
                description={<span className="num">{p.base_url || "官方地址"}</span>}
                actions={
                  <>
                    <Button size="sm" icon={<Plus />} onClick={() => setEditing({ kind: "model", provider: pi, index: -1 })}>
                      添加模型
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Pencil />} aria-label={`编辑接口 ${p.name || p.id}`} onClick={() => setEditing({ kind: "provider", index: pi })} />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 />}
                      aria-label={`删除接口 ${p.name || p.id}`}
                      disabled={inUse}
                      title={inUse ? "它的模型正在被使用，先在抓取或深度研究页改掉指派" : undefined}
                      onClick={async () => {
                        if (await confirm({ title: `删除接口 ${p.name || p.id}？`, body: "接口和它下面的模型一起删除，立即生效。", confirm: "删除", danger: true })) update((d) => void d.llm.providers.splice(pi, 1));
                      }}
                    />
                  </>
                }
              >
                {p.models.length === 0 ? (
                  <div className="px-4 py-5 text-xs text-ink-3">这个接口下还没有模型。添加模型后才能把它指派给提取或研究。</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <thead>
                        <tr>
                          <Th>模型 ID</Th>
                          <Th>上游模型名</Th>
                          <Th>限流</Th>
                          <Th className="text-right">并发</Th>
                          <Th className="text-right">最大输出</Th>
                          <Th>推理</Th>
                          <Th>附加字段</Th>
                          <Th>用于</Th>
                          <Th />
                        </tr>
                      </thead>
                      <tbody>
                        {p.models.map((m, mi) => {
                          const roles = rolesOf(config, m.id);
                          const health = status?.models.find((s) => s.id === m.id);
                          return (
                            <tr key={m.id} className="last:[&>td]:border-b-0">
                              <Td className="num font-medium whitespace-nowrap">
                                <span className="flex items-center gap-2">
                                  {m.id}
                                  {health?.disabled && (
                                    <Tooltip content={health.disabled_detail ?? "短时间内连续失败，冷却后自动重试"}>
                                      <span className="flex items-center gap-2 font-sans font-normal">
                                        <Tripped id={health.key} health={health} />
                                      </span>
                                    </Tooltip>
                                  )}
                                </span>
                              </Td>
                              <Td className="num text-xs whitespace-nowrap text-ink-2">{m.name}</Td>
                              <Td className="num text-xs whitespace-nowrap text-ink-2">{m.rate_limit || "不限"}</Td>
                              <Td className="num text-right text-xs text-ink-2">{m.concurrency || "不限"}</Td>
                              <Td className="num text-right text-xs text-ink-2">{m.max_output_tokens ? compact(m.max_output_tokens) : "默认"}</Td>
                              <Td className="text-xs whitespace-nowrap text-ink-2">{reasoningLabel(m.reasoning)}</Td>
                              <Td className="num max-w-48 truncate text-xs text-ink-3">{m.extra_body ? Object.keys(m.extra_body).join(", ") : "—"}</Td>
                              <Td>
                                <span className="flex gap-1">
                                  {roles.length === 0 ? (
                                    <span className="text-xs text-ink-3">未指派</span>
                                  ) : (
                                    roles.map((role) => (
                                      <Badge key={role} tone="signal">
                                        {role}
                                      </Badge>
                                    ))
                                  )}
                                </span>
                              </Td>
                              <Td className="w-0">
                                <span className="flex justify-end gap-1">
                                  <Button size="sm" variant="ghost" icon={<Pencil />} aria-label={`编辑模型 ${m.id}`} onClick={() => setEditing({ kind: "model", provider: pi, index: mi })} />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={<Trash2 />}
                                    aria-label={`删除模型 ${m.id}`}
                                    disabled={roles.length > 0}
                                    title={roles.length > 0 ? "正在被使用，先在抓取或深度研究页改掉指派" : undefined}
                                    onClick={async () => {
                                      if (await confirm({ title: `删除模型 ${m.id}？`, body: "立即生效。", confirm: "删除", danger: true })) update((d) => void d.llm.providers[pi].models.splice(mi, 1));
                                    }}
                                  />
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
            );
          })}
        </div>
      )}

      {editing?.kind === "provider" && (
        <ProviderDialog
          initial={editing.index === -1 ? blankProvider : providers[editing.index]}
          isNew={editing.index === -1}
          taken={providers.filter((_, i) => i !== editing.index).map((p) => p.id)}
          onClose={() => setEditing(null)}
          onSubmit={(next) => {
            update((d) => {
              if (editing.index === -1) d.llm.providers.push(next);
              else d.llm.providers[editing.index] = next;
            });
            // A new provider is useless without a model, so go straight on to one.
            setEditing(editing.index === -1 ? { kind: "model", provider: providers.length, index: -1 } : null);
          }}
        />
      )}
      {editing?.kind === "model" && providers[editing.provider] && (
        <ModelDialog
          provider={providers[editing.provider]}
          initial={editing.index === -1 ? blankModel : providers[editing.provider].models[editing.index]}
          isNew={editing.index === -1}
          taken={editing.index === -1 ? modelIDs : modelIDs.filter((id) => id !== providers[editing.provider].models[editing.index].id)}
          onClose={() => setEditing(null)}
          onSubmit={(next) => {
            update((d) => {
              const models = d.llm.providers[editing.provider].models;
              if (editing.index === -1) models.push(next);
              else models[editing.index] = next;
            });
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function ProviderDialog({
  initial,
  isNew,
  taken,
  onClose,
  onSubmit,
}: {
  initial: LLMProvider;
  isNew: boolean;
  taken: string[];
  onClose: () => void;
  onSubmit: (provider: LLMProvider) => void;
}) {
  const [form, setForm] = useState<LLMProvider>(() => structuredClone(initial));
  const set = (change: Partial<LLMProvider>) => setForm((f) => ({ ...f, ...change }));

  const idError = !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(form.id) ? "小写字母、数字、- 或 _，最长 32 位" : taken.includes(form.id) ? "这个 ID 已被使用" : "";
  const urlError = form.type === "openai-compatible" && !form.base_url ? "OpenAI 兼容接口必须填写地址" : form.base_url && !/^https?:\/\/.+/.test(form.base_url) ? "需要以 http:// 或 https:// 开头" : "";
  const valid = !idError && !urlError;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={isNew ? "添加模型接口" : `编辑 ${initial.name || initial.id}`}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSubmit(form)}>
            {isNew ? "下一步：添加模型" : "完成"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="接口格式">
          <Segmented
            value={form.type}
            onChange={(type) => set({ type })}
            options={[
              { value: "openai-compatible", label: "OpenAI 兼容" },
              { value: "anthropic", label: "Anthropic" },
            ]}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ID" hint={isNew ? "创建后不能修改" : undefined} error={form.id ? idError : undefined}>
            <Input mono value={form.id} disabled={!isNew} placeholder="openrouter" onChange={(e) => set({ id: e.target.value.trim().toLowerCase() })} />
          </Field>
          <Field label="显示名称">
            <Input value={form.name} placeholder="OpenRouter" onChange={(e) => set({ name: e.target.value })} />
          </Field>
        </div>
        <Field
          label="Base URL"
          error={urlError || undefined}
          hint={form.type === "anthropic" ? "留空使用 https://api.anthropic.com；中转站填到域名即可，不带 /v1" : "填到 /v1 为止，例如 https://api.openai.com/v1"}
        >
          <Input mono value={form.base_url} placeholder={form.type === "anthropic" ? "https://api.anthropic.com" : "https://…/v1"} onChange={(e) => set({ base_url: e.target.value.trim() })} />
        </Field>
        <Field label="API key">
          <SecretInput value={form} onChange={setForm} />
        </Field>
        <details className="group">
          <summary className="tag list-none normal-case hover:text-ink-2">
            <span className="group-open:hidden">+ 自定义请求头</span>
            <span className="hidden group-open:inline">− 自定义请求头</span>
          </summary>
          <JSONInput className="mt-3" value={form.headers} onChange={(headers) => set({ headers: headers as Record<string, string> | undefined })} placeholder={'{ "HTTP-Referer": "https://example.com" }'} />
        </details>
      </div>
    </Dialog>
  );
}

function ModelDialog({
  provider,
  initial,
  isNew,
  taken,
  onClose,
  onSubmit,
}: {
  provider: LLMProvider;
  initial: Model;
  isNew: boolean;
  taken: string[];
  onClose: () => void;
  onSubmit: (model: Model) => void;
}) {
  const [form, setForm] = useState<Model>(() => structuredClone(initial));
  // Until the id is typed by hand it follows the model name.
  const [idTouched, setIdTouched] = useState(!isNew);
  const [test, setTest] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const set = (change: Partial<Model>) => setForm((f) => ({ ...f, ...change }));

  const idError = !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(form.id) ? "小写字母、数字、. - 或 _，最长 64 位" : taken.includes(form.id) ? "这个 ID 已被使用（模型 ID 在所有接口中唯一）" : "";
  const valid = !idError && form.name !== "";

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const res = await api.playModel(provider, form);
      setTest({ tone: "ok", text: `连接正常，${duration(res.duration_ms)}，模型回复：${res.reply}` });
    } catch (err) {
      setTest({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={isNew ? "添加模型" : `编辑 ${initial.id}`}
      description={`接口：${provider.name || provider.id}`}
      footer={
        <>
          <Button icon={<Zap />} loading={testing} disabled={!form.name} onClick={runTest} className="mr-auto">
            测试
          </Button>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSubmit(form)}>
            {isNew ? "添加" : "完成"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="上游模型名" hint="按接口方的模型名原样填写">
            <Input
              mono
              autoFocus={isNew}
              value={form.name}
              placeholder="claude-haiku-5-5"
              onChange={(e) => {
                const name = e.target.value.trim();
                set(idTouched ? { name } : { name, id: toModelID(name) });
              }}
            />
          </Field>
          <Field label="模型 ID" hint={isNew ? "功能靠它引用这个模型，创建后不能修改。同一上游模型想要两套参数，就建两个 ID" : undefined} error={form.id ? idError : undefined}>
            <Input
              mono
              value={form.id}
              disabled={!isNew}
              placeholder="haiku-fast"
              onChange={(e) => {
                setIdTouched(true);
                set({ id: e.target.value.trim().toLowerCase() });
              }}
            />
          </Field>
        </div>

        <div className="rounded-ctl border border-line">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-3 py-2.5">
            <div>
              <div className="text-sm">限流</div>
              <div className="text-xs text-ink-3">所有使用这个模型的功能共用</div>
            </div>
            <RateLimitInput value={form.rate_limit} fallback="60/m" onChange={(rate_limit) => set({ rate_limit })} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-3 py-2.5">
            <div>
              <div className="text-sm">并发上限</div>
              <div className="text-xs text-ink-3">同时进行的请求数，0 为不限</div>
            </div>
            <NumberInput className="w-20" value={form.concurrency} onChange={(n) => set({ concurrency: Math.round(n) })} aria-label="并发上限" />
          </div>
        </div>

        <ReasoningEditor type={provider.type} value={form.reasoning} onChange={(reasoning) => set({ reasoning })} />

        <Field label="最大输出 token" hint="0 为使用接口默认值" className="max-w-48">
          <NumberInput value={form.max_output_tokens ?? 0} onChange={(n) => set({ max_output_tokens: Math.round(n) || undefined })} />
        </Field>
        <Field label="附加请求字段" hint="原样合并进请求体的 JSON，最后合并，会覆盖上面的同名设置。用于界面没有覆盖到的参数">
          <JSONInput value={form.extra_body} onChange={(extra_body) => set({ extra_body })} placeholder={'{ "top_p": 0.9 }'} />
        </Field>

        {test && <Notice tone={test.tone}>{test.text}</Notice>}
      </div>
    </Dialog>
  );
}

/** Reasoning as a choice instead of raw request fields; what is offered depends on the API format. */
function ReasoningEditor({ type, value, onChange }: { type: LLMType; value: Reasoning; onChange: (value: Reasoning) => void }) {
  const { meta } = useConfig();
  const efforts = meta.reasoning_efforts[type];
  const hints: Record<Reasoning["mode"], string> = {
    "": "不发送任何推理参数，由模型自己的默认行为决定。",
    off: type === "anthropic" ? "发送 thinking: disabled。" : "发送 reasoning_effort: none；不支持该取值的模型会报错，可改用「模型默认」。",
    effort: type === "anthropic" ? "自适应思考，并用 effort 控制投入程度。" : "发送 reasoning_effort。",
    budget: "固定的思考 token 预算；只接受自适应思考的新模型会自动改用自适应。",
  };
  return (
    <div className="rounded-ctl border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="text-sm">推理</div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            value={value.mode}
            onChange={(mode) =>
              onChange(mode === "effort" ? { mode, effort: efforts.includes(value.effort ?? "") ? value.effort : "medium" } : mode === "budget" ? { mode, budget_tokens: value.budget_tokens || 4096 } : { mode })
            }
            options={[
              { value: "", label: "模型默认" },
              { value: "off", label: "关闭" },
              { value: "effort", label: "强度" },
              ...(type === "anthropic" ? [{ value: "budget" as const, label: "预算" }] : []),
            ]}
          />
          {value.mode === "effort" && (
            <Select className="w-24" value={value.effort} onChange={(e) => onChange({ mode: "effort", effort: e.target.value })} aria-label="推理强度">
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </Select>
          )}
          {value.mode === "budget" && <NumberInput className="w-32" min={1024} suffix="token" value={value.budget_tokens ?? 4096} onChange={(n) => onChange({ mode: "budget", budget_tokens: Math.round(n) })} aria-label="思考预算" />}
        </div>
      </div>
      <div className="mt-1 text-xs text-ink-3">{hints[value.mode]}</div>
    </div>
  );
}
