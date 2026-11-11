import { Bot, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import { api, type Config, type LLMProvider, type LLMType, type Model, type Reasoning } from "../lib/api";
import { TrippedState, useStatus } from "../components/Health";
import { useConfig } from "../lib/config";
import { compact, duration } from "../lib/format";
import { PageHeader } from "../components/PageHeader";
import { JSONInput, parseRateLimit, RateLimitInput, SecretInput } from "../ui/inputs";
import { Dialog, useConfirm } from "../ui/overlays";
import { Badge, Button, cx, Empty, Field, IconButton, Info, Input, Notice, NumberInput, Panel, Section, Segmented, Select, Tooltip } from "../ui/primitives";

const typeLabel: Record<LLMType, string> = { "openai-compatible": "OpenAI 兼容", anthropic: "Anthropic" };

const blankProvider: LLMProvider = { id: "", name: "", type: "openai-compatible", base_url: "", api_key: "", models: [] };
const blankModel: Model = { id: "", name: "", reasoning: { mode: "" }, rate_limit: "", concurrency: 0 };

interface Role {
  label: string;
  href: string;
}

/** The features a model is assigned to, with the page each is configured on. */
function rolesOf(config: Config, id: string): Role[] {
  const position = config.fetch.extract.models.indexOf(id);
  return [
    ...(position === 0
      ? [{ label: "提取 · 首选", href: "/tools/fetch" }]
      : position > 0
        ? [{ label: `提取 · 备用 ${position}`, href: "/tools/fetch" }]
        : []),
    ...(config.research.model === id ? [{ label: "研究", href: "/tools/research" }] : []),
  ];
}

/** Derives a provider id from its display name. */
const toProviderID = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);

/** Derives a model id from the model name the same way the server does. */
const toModelID = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);

function ReasoningSummary({ reasoning }: { reasoning: Reasoning }) {
  switch (reasoning.mode) {
    case "off":
      return <span className="text-ink-3">关闭</span>;
    case "effort":
      return (
        <span>
          强度 · <span className="num">{reasoning.effort}</span>
        </span>
      );
    case "budget":
      return (
        <span>
          预算 · <span className="num">{compact(reasoning.budget_tokens ?? 0)}</span>
        </span>
      );
    default:
      return <span className="text-ink-3">模型默认</span>;
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

  // Shared across every provider panel so columns line up down the page.
  // model id · [upstream name] · limit · reasoning & params · roles · actions
  const tail = ["6.5rem", "minmax(8.5rem,1fr)", "6.5rem", "3.75rem"];
  const grid = {
    "--cols": ["minmax(10rem,1.2fr)", ...tail].join(" "),
    "--cols-lg": ["minmax(11rem,1.15fr)", "minmax(14rem,1.8fr)", ...tail].join(" "),
  } as CSSProperties;
  const columns = "sm:grid-cols-(--cols) lg:grid-cols-(--cols-lg)";

  return (
    <>
      <PageHeader
        title="模型接口"
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ kind: "provider", index: -1 })}>
            添加接口
          </Button>
        }
      />

      {providers.length === 0 ? (
        <Panel>
          <Empty size="page" icon={<Bot />} title="尚无模型接口">
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ kind: "provider", index: -1 })}>
              添加接口
            </Button>
          </Empty>
        </Panel>
      ) : (
        <div style={grid} className="flex flex-col gap-3">
          {providers.map((p, pi) => {
            const inUse = p.models.some((m) => rolesOf(config, m.id).length > 0);
            const hasKey = Boolean(p.api_key || (p.api_key_hint && !p.clear_api_key));
            return (
              <Panel
                key={p.id}
                flush
                title={
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate">{p.name || p.id}</span>
                    <Badge>{typeLabel[p.type]}</Badge>
                    {!hasKey && (
                      <Badge tone="warn" dot>
                        未设置密钥
                      </Badge>
                    )}
                  </span>
                }
                actions={
                  <div className="flex items-center gap-1">
                    <Button size="sm" className="mr-1" icon={<Plus />} onClick={() => setEditing({ kind: "model", provider: pi, index: -1 })}>
                      添加模型
                    </Button>
                    <IconButton size="sm" icon={<Pencil />} label={`编辑接口 ${p.name || p.id}`} onClick={() => setEditing({ kind: "provider", index: pi })} />
                    <InUse when={inUse}>
                      <IconButton
                        size="sm"
                        icon={<Trash2 />}
                        label={`删除接口 ${p.name || p.id}`}
                        disabled={inUse}
                        onClick={async () => {
                          if (await confirm({ title: `删除接口 ${p.name || p.id}？`, body: p.models.length > 0 ? `其下 ${p.models.length} 个模型一并删除。` : undefined, confirm: "删除", danger: true }))
                            update((d) => void d.llm.providers.splice(pi, 1));
                        }}
                      />
                    </InUse>
                  </div>
                }
              >
                {p.models.length === 0 ? (
                  <Empty title="尚无模型">
                    <Button size="sm" icon={<Plus />} onClick={() => setEditing({ kind: "model", provider: pi, index: -1 })}>
                      添加模型
                    </Button>
                  </Empty>
                ) : (
                  <div>
                    <div className={cx("hidden h-9 items-center gap-x-3 border-b border-line px-4 sm:grid", columns)}>
                      <span className="tag">模型 ID</span>
                      <span className="tag hidden lg:block">上游模型名</span>
                      <span className="tag">限流</span>
                      <span className="tag">推理与参数</span>
                      <span className="tag">用于</span>
                      <span />
                    </div>
                    <ol>
                      {p.models.map((m, mi) => {
                        const roles = rolesOf(config, m.id);
                        const health = status?.models.find((s) => s.id === m.id);
                        const extraKeys = m.extra_body ? Object.keys(m.extra_body) : [];
                        return (
                          <li
                            key={m.id}
                            className={cx(
                              "grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5 transition-colors last:border-b-0 hover:bg-fill",
                              columns,
                            )}
                          >
                            <div className="flex min-w-0 flex-col justify-center">
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="num truncate text-sm font-medium" title={m.id}>
                                  {m.id}
                                </span>
                                {health?.disabled && <TrippedState id={health.key} health={health} />}
                              </span>
                              {m.name !== m.id && (
                                <span className="num truncate text-xs text-ink-3 lg:hidden" title={m.name}>
                                  {m.name}
                                </span>
                              )}
                            </div>

                            <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 sm:contents">
                              <span className={cx("num hidden truncate text-xs lg:block", m.name === m.id ? "text-ink-3" : "text-ink-2")} title={m.name}>
                                {m.name}
                              </span>

                              <ModelLimit rate={m.rate_limit} concurrency={m.concurrency} />

                              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-2">
                                <ReasoningSummary reasoning={m.reasoning} />
                                {m.max_output_tokens ? <span className="num text-ink-3">· ≤ {compact(m.max_output_tokens)}</span> : null}
                                {extraKeys.length > 0 && (
                                  <Tooltip content={`附加请求字段：${extraKeys.join(", ")}`}>
                                    <span className="num text-ink-3">· +{extraKeys.length} 字段</span>
                                  </Tooltip>
                                )}
                              </span>

                              <span className="flex min-w-0 flex-wrap items-center gap-1">
                                {roles.length === 0 ? (
                                  <span className="text-xs text-ink-3">未关联</span>
                                ) : (
                                  roles.map((role) => (
                                    <Link key={role.label} href={role.href} className="press rounded-tag">
                                      <Badge>{role.label}</Badge>
                                    </Link>
                                  ))
                                )}
                              </span>
                            </div>

                            <span className="col-start-2 row-start-1 flex items-center justify-end gap-1 sm:col-auto sm:row-auto">
                              <IconButton size="sm" icon={<Pencil />} label={`编辑模型 ${m.id}`} onClick={() => setEditing({ kind: "model", provider: pi, index: mi })} />
                              <InUse when={roles.length > 0}>
                                <IconButton
                                  size="sm"
                                  icon={<Trash2 />}
                                  label={`删除模型 ${m.id}`}
                                  disabled={roles.length > 0}
                                  onClick={async () => {
                                    if (await confirm({ title: `删除模型 ${m.id}？`, confirm: "删除", danger: true })) update((d) => void d.llm.providers[pi].models.splice(mi, 1));
                                  }}
                                />
                              </InUse>
                            </span>
                          </li>
                        );
                      })}
                    </ol>
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

function ModelLimit({ rate, concurrency }: { rate: string; concurrency: number }) {
  const limit = parseRateLimit(rate);
  if (!limit && concurrency <= 0) return <span className="text-xs text-ink-3">不限</span>;
  return (
    <span className="num flex items-baseline whitespace-nowrap text-xs text-ink-2">
      {limit ? (
        <span>
          {limit.requests}/{limit.every > 1 ? limit.every : ""}
          {limit.unit}
        </span>
      ) : (
        <span className="font-sans text-ink-3">不限</span>
      )}
      {concurrency > 0 && <span className="ml-1 text-ink-3">· 并发 {concurrency}</span>}
    </span>
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
  const [idTouched, setIdTouched] = useState(!isNew);
  const set = (change: Partial<LLMProvider>) => setForm((f) => ({ ...f, ...change }));

  const idError = !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(form.id) ? "小写字母、数字、- 或 _，最长 32 位" : taken.includes(form.id) ? "该 ID 已被使用" : "";
  const urlError = form.type === "openai-compatible" && !form.base_url ? "OpenAI 兼容接口必须填写地址" : form.base_url && !/^https?:\/\/.+/.test(form.base_url) ? "须以 http:// 或 https:// 开头" : "";
  const valid = !idError && !urlError;
  const headerCount = form.headers ? Object.keys(form.headers).length : 0;

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="显示名称">
            <Input
              autoFocus={isNew}
              value={form.name}
              placeholder="OpenRouter"
              onChange={(e) => {
                const name = e.target.value;
                const derived = toProviderID(name);
                set(!idTouched && derived ? { name, id: derived } : { name });
              }}
            />
          </Field>
          <Field label="ID" hint={isNew ? "创建后不可修改" : undefined} error={form.id ? idError : undefined}>
            <Input
              mono
              value={form.id}
              disabled={!isNew}
              placeholder="openrouter"
              onChange={(e) => {
                setIdTouched(true);
                set({ id: e.target.value.trim().toLowerCase() });
              }}
            />
          </Field>
        </div>
        <Field label="Base URL" error={urlError || undefined} hint={form.type === "anthropic" ? "不含 /v1" : "含 /v1"}>
          <Input mono value={form.base_url} placeholder={form.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} onChange={(e) => set({ base_url: e.target.value.trim() })} />
        </Field>
        <Field label="API Key">
          <SecretInput value={form} onChange={setForm} />
        </Field>
        <div className="rounded-ctl border border-line [&>*:first-child]:border-t-0">
          <Section title="自定义请求头" summary={headerCount > 0 ? `${headerCount} 项` : "无"} defaultOpen={headerCount > 0}>
            <JSONInput value={form.headers} onChange={(headers) => set({ headers: headers as Record<string, string> | undefined })} placeholder={'{ "HTTP-Referer": "https://example.com" }'} />
          </Section>
        </div>
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

  const idError = !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(form.id) ? "小写字母、数字、. - 或 _，最长 64 位" : taken.includes(form.id) ? "该 ID 已被使用（模型 ID 在所有接口中唯一）" : "";
  const valid = !idError && form.name !== "";
  const extraCount = form.extra_body ? Object.keys(form.extra_body).length : 0;

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="上游模型名">
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
          <Field label="模型 ID" hint={isNew ? "创建后不可修改" : undefined} error={form.id ? idError : undefined}>
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

        <ReasoningEditor type={provider.type} value={form.reasoning} onChange={(reasoning) => set({ reasoning })} />

        <Field label="配额限流">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <RateLimitInput value={form.rate_limit} fallback="60/m" onChange={(rate_limit) => set({ rate_limit })} />
            <div className="flex items-center gap-1.5 text-xs text-ink-3">
              <span>并发</span>
              <NumberInput className="w-20" min={0} zero="不限" value={form.concurrency} onChange={(n) => set({ concurrency: Math.max(0, Math.round(n)) })} aria-label="并发上限" />
            </div>
          </div>
        </Field>

        <Field label="最大输出 Token">
          <NumberInput className="w-36" min={0} zero={provider.type === "anthropic" ? "默认 32000" : "不限"} value={form.max_output_tokens ?? 0} onChange={(n) => set({ max_output_tokens: Math.round(n) || undefined })} />
        </Field>

        <div className="rounded-ctl border border-line [&>*:first-child]:border-t-0">
          <Section title="附加请求字段" summary={extraCount > 0 ? `${extraCount} 个字段` : "无"} defaultOpen={extraCount > 0}>
            <Field label="JSON 对象" hint="合并进请求体，覆盖同名字段">
              <JSONInput value={form.extra_body} onChange={(extra_body) => set({ extra_body })} placeholder={'{ "top_p": 0.9 }'} />
            </Field>
          </Section>
        </div>

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
    "": "",
    off: type === "anthropic" ? "thinking: disabled" : "reasoning_effort: none，部分模型不支持",
    effort: type === "anthropic" ? "自适应思考 + effort" : "reasoning_effort",
    budget: "只支持自适应思考的模型会改用自适应",
  };
  return (
    <Field label="推理" hint={hints[value.mode] || undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
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
          <Select
            className="w-28"
            value={value.effort ?? ""}
            onChange={(effort) => onChange({ mode: "effort", effort })}
            options={efforts.map((effort) => ({ value: effort, label: effort }))}
            aria-label="推理强度"
          />
        )}
        {value.mode === "budget" && <NumberInput className="w-32" min={1024} suffix="Token" value={value.budget_tokens ?? 4096} onChange={(n) => onChange({ mode: "budget", budget_tokens: Math.round(n) })} aria-label="思考预算" />}
      </div>
    </Field>
  );
}

/** A control that cannot be used while the model is assigned; hover or tap gives the reason. */
function InUse({ when, children }: { when: boolean; children: ReactNode }) {
  if (!when) return children;
  return (
    // The disabled control takes no pointer events, so they reach the wrapper.
    <Info trigger={<span tabIndex={0} className="inline-flex rounded-ctl [&>*]:pointer-events-none">{children}</span>}>
      使用中，先在网页抓取或深度研究中移除
    </Info>
  );
}
