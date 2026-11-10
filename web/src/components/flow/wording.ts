import type { NodeStatus, TraceNode } from "../../lib/api";
import { bytes, clock, compact, duration, toolLabel } from "../../lib/format";
import { attr } from "../../lib/trace";
import type { Tone } from "../../ui/primitives";

/* What the nodes of a trace are called in the console. */

export const kindLabel: Record<string, string> = {
  call: "入口",
  cache: "缓存",
  route: "路由",
  run: "执行",
  attempt: "上游",
  wait: "等待",
  worker: "Worker",
  page: "正文",
  decide: "判断",
  extract: "提取",
  llm: "模型",
  result: "返回",
  query: "查询",
  merge: "合并",
  agent: "研究",
  step: "步骤",
  tool: "工具",
  wrap_up: "收尾",
};

export const statusLabel: Record<NodeStatus, string> = {
  running: "进行中",
  ok: "成功",
  error: "失败",
  canceled: "已取消",
  cached: "缓存命中",
  skipped: "熔断跳过",
  limited: "限流跳过",
};

export const statusTone: Record<NodeStatus, Tone> = {
  running: "signal",
  ok: "ok",
  error: "err",
  canceled: "neutral",
  cached: "info",
  skipped: "warn",
  limited: "warn",
};

/** Nodes that are a decision made in an instant, drawn as a pill; the others take time and are cards. */
const instants = new Set(["cache", "decide", "merge", "wrap_up", "page", "result", "wait", "run", "extract"]);
export const isPill = (node: TraceNode) => instants.has(node.kind);

const cacheName: Record<string, string> = { page: "正文缓存", gone: "失效记录", answer: "回答缓存" };
const cacheMiss: Record<string, string> = {
  miss: "未命中",
  bypassed: "本次不读缓存",
  other_engine: "有缓存，但来自别的引擎",
  rendered: "有缓存，但本次要渲染后的页面",
};
const runName: Record<string, string> = { hedged: "对冲竞速", fallback: "顺序回退", single: "单路" };
const waitName: Record<string, string> = { rate_limit: "等速率配额", retry: "重试前等待", concurrency: "等并发槽位" };
const decideName: Record<string, string> = {
  raw: "按原文返回",
  source_code: "源码文件，原样返回",
  passthrough: "篇幅够短，原样返回",
  no_model: "没有可用的提取模型，返回原文",
  extract: "交给模型提取",
};
const wrapName: Record<string, string> = { steps: "步数用尽", duration: "时间用尽", tokens: "Token 预算用尽", context: "上下文将满" };
export const triggerName: Record<string, string> = {
  first: "首选",
  after_failure: "上一个失败后接替",
  after_rate_limit: "上一个限流后接替",
  slow: "慢请求对冲",
  slot_freed: "速率配额空出",
  retry: "重试",
};
export const candidateReason: Record<string, string> = {
  disabled: "已停用",
  no_credentials: "缺少凭据",
  offline: "离线",
  not_pinned: "未被指定",
  not_in_rule: "不在规则内",
};
const routeMode: Record<string, string> = { auto: "自动", pinned: "指定引擎", rule: "命中规则" };
const skipReason: Record<string, string> = { auth: "鉴权失败后停用", quota: "额度用尽后停用", provider: "连续失败，熔断中" };
const sourceName: Record<string, string> = { mcp: "MCP 客户端", webui: "调试台", playground: "调试台" };
const toolName: Record<string, string> = { search: "网页搜索", dev_search: "开发搜索", fetch: "网页抓取", read_page: "翻页阅读", research: "深度研究" };

export interface Candidate {
  provider: string;
  eligible: boolean;
  reason?: string;
}
export const candidates = (node: TraceNode) => attr<Candidate[]>(node, "candidates") ?? [];

const count = (n: number) => n.toLocaleString("en-US");
const chars = (n: number) => `${compact(n)} 字`;

/** The name a node goes by on its card. Providers and models are named by the card itself. */
export function titleOf(node: TraceNode): string {
  switch (node.kind) {
    case "call":
      return toolName[node.name ?? ""] ?? node.name ?? "调用";
    case "cache":
      return cacheName[node.name ?? ""] ?? "缓存";
    case "run":
      return runName[node.name ?? ""] ?? "执行";
    case "wait":
      return waitName[node.name ?? ""] ?? "等待";
    case "decide":
      return "判断";
    case "wrap_up":
      return "收尾";
    case "tool":
      return toolName[node.name ?? ""] ?? node.name ?? "工具";
    case "step":
      return `步骤 ${node.name ?? ""}`;
    default:
      return kindLabel[node.kind] ?? node.kind;
  }
}

/** What a node concluded, in a few words: the text of its pill, the second line of its card. */
export function conclusion(node: TraceNode): string {
  const a = <T,>(key: string) => attr<T>(node, key);
  const parts: (string | undefined | false)[] = [];
  switch (node.kind) {
    case "call":
      parts.push(sourceName[a<string>("source") ?? ""] ?? a<string>("source"), a<string>("api_key_name"));
      break;
    case "cache":
      if (a<boolean>("hit") && node.status === "cached") {
        parts.push(node.name === "gone" ? "命中：这一页已确认失效" : "命中", a<string>("engine"), a<number>("bytes") != null && bytes(a<number>("bytes")!));
      } else {
        parts.push(cacheMiss[a<string>("reason") ?? "miss"] ?? a<string>("reason"));
      }
      break;
    case "route": {
      const list = candidates(node);
      const out = list.filter((c) => !c.eligible).length;
      const rule = a<{ name?: string }>("rule");
      parts.push(
        a<string>("mode") === "rule" && rule?.name ? `命中规则「${rule.name}」` : a<string>("mode") === "pinned" ? `指定 ${a<string>("engine") ?? ""}` : "自动",
        a<boolean>("cached") ? "命中缓存，未请求上游" : list.length > 0 && `${list.length} 个候选${out ? `，${out} 个不可用` : ""}`,
      );
      break;
    }
    case "run":
      parts.push(
        a<number>("slow_threshold_ms") ? `慢于 ${duration(a<number>("slow_threshold_ms")!)} 加开下一个` : undefined,
        a<number>("timeout_ms") ? `超时 ${duration(a<number>("timeout_ms")!)}` : undefined,
      );
      break;
    case "page":
      parts.push(a<number>("bytes") != null && bytes(a<number>("bytes")!), a<boolean>("rendered") && "渲染后", a<boolean>("cached") && "来自缓存");
      break;
    case "decide":
      parts.push(decideName[node.name ?? ""] ?? node.name);
      break;
    case "extract": {
      const models = a<string[]>("models") ?? [];
      parts.push(models.length > 1 ? `${models.length} 个模型依次尝试` : models[0], a<string>("fallback") === "raw" && "模型都失败，改回原文");
      break;
    }
    case "merge":
      parts.push(
        a<number>("total") != null && `共 ${a<number>("total")} 条`,
        a<number>("deduped") ? `去重 ${a<number>("deduped")}` : undefined,
        a<number>("filtered") ? `过滤 ${a<number>("filtered")}` : undefined,
      );
      break;
    case "wrap_up":
      parts.push(`${wrapName[node.name ?? ""] ?? node.name}，要求写出报告`);
      break;
    case "result":
      if (node.status === "canceled") parts.push("已中止");
      else if (node.status === "error" || a<string>("kind") === "error") parts.push("返回错误");
      else if (a<string>("kind") === "answer") parts.push("模型的回答", a<number>("text_length") != null && chars(a<number>("text_length")!));
      else if (a<string>("kind") === "text") parts.push("正文", a<number>("text_length") != null && chars(a<number>("text_length")!), a<boolean>("truncated") && "未完，可翻页");
      else if (a<number>("report_bytes") != null)
        parts.push(a<number>("report_bytes") ? `报告 ${bytes(a<number>("report_bytes")!)}` : "没有写出报告", a<number>("steps") != null && `${a<number>("steps")} 步`, a<string>("exhausted") && "预算用尽");
      else if (a<number>("queries") != null) parts.push(`${a<number>("items") ?? 0} 条结果`, a<number>("failed") ? `${a<number>("failed")}/${a<number>("queries")} 个查询失败` : undefined);
      else if (a<number>("items") != null) parts.push(`${a<number>("items")} 条结果`);
      else parts.push("已返回");
      break;
    case "attempt":
      if (node.status === "skipped") parts.push(skipReason[a<string>("reason") ?? ""] ?? "熔断中");
      else if (node.status === "limited") parts.push("速率配额已满", a<number>("wait_ms") ? `${duration(a<number>("wait_ms")!)} 后恢复` : undefined);
      else
        parts.push(
          triggerName[a<string>("trigger") ?? ""],
          a<number>("try") && a<number>("try")! > 1 ? `第 ${a<number>("try")} 次` : undefined,
          node.http_status ? `HTTP ${node.http_status}` : undefined,
          a<number>("bytes") != null ? bytes(a<number>("bytes")!) : undefined,
          a<number>("results") != null ? `${a<number>("results")} 条` : undefined,
        );
      break;
    case "llm":
    case "agent": {
      const reasoning = a<{ mode?: string; effort?: string; budget_tokens?: number }>("reasoning");
      const usage = a<Usage>("usage");
      parts.push(
        a<number>("try") && a<number>("try")! > 1 ? `第 ${a<number>("try")} 次` : undefined,
        reasoningText(reasoning),
        usage ? `↑${compact(usage.input_tokens ?? 0)} ↓${compact(usage.output_tokens ?? 0)}` : undefined,
        a<number>("first_chunk_ms") != null ? `首包 ${duration(a<number>("first_chunk_ms")!)}` : undefined,
      );
      break;
    }
    case "worker":
      parts.push(a<string>("profile"), a<string>("adapter") && `适配器 ${a<string>("adapter")}`);
      break;
    case "query":
      parts.push(a<number>("web") != null && `${a<number>("web")} 条网页`, a<number>("videos") ? `${a<number>("videos")} 条视频` : undefined);
      break;
    case "step": {
      const usage = a<Usage>("usage");
      parts.push(
        a<boolean>("final") && "写报告",
        usage ? `↑${compact(usage.input_tokens ?? 0)} ↓${compact(usage.output_tokens ?? 0)}` : undefined,
        a<number>("context_tokens") != null && `上下文 ${compact(a<number>("context_tokens")!)}`,
      );
      break;
    }
  }
  return parts.filter(Boolean).join(" · ");
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export function reasoningText(r: { mode?: string; effort?: string; budget_tokens?: number } | undefined): string | undefined {
  if (!r || !r.mode) return undefined;
  if (r.mode === "off") return "不推理";
  if (r.mode === "effort") return `推理 ${r.effort ?? ""}`.trim();
  if (r.mode === "budget") return `推理预算 ${compact(r.budget_tokens ?? 0)}`;
  return r.mode;
}

/** What a tool call or a call was asked: its query, its address. */
export function subject(node: TraceNode): string {
  const args = attr<Record<string, unknown>>(node, "args");
  if (!args) return "";
  for (const key of ["url", "query", "question", "task", "queries"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value) && value.length) return value.join(" · ");
  }
  return "";
}

/* ---------- The facts of a node ---------- */

type Format = (value: unknown, node: TraceNode) => string;

const ms: Format = (v) => duration(Number(v));
const size: Format = (v) => bytes(Number(v));
const number: Format = (v) => count(Number(v));
const yes: Format = (v) => (v ? "是" : "否");
const from = (names: Record<string, string>): Format => (v) => names[String(v)] ?? String(v);
/** A moment: the gateway gives it on its own clock, or as a span from now. */
const until: Format = (v) => (Number(v) > 1e11 ? clock(Number(v)) : `${duration(Number(v))} 后`);

interface Fact {
  label: string;
  group?: string;
  format?: Format;
}

const PARAMS = "模型参数";
const USAGE = "用量";
const CALLER = "调用方";
const OVERRIDE = "仅此次的覆盖";
const POLICY = "密钥策略";
const BUDGET = "预算";
const RULE = "规则";

/** Every attribute the gateway is known to send, by its (flattened) key. Others are shown under their own key. */
const facts: Record<string, Fact> = {
  source: { label: "来源", group: CALLER, format: from(sourceName) },
  api_key_name: { label: "密钥", group: CALLER },
  client_ip: { label: "地址", group: CALLER },
  config_version: { label: "配置版本", group: CALLER },
  task_id: { label: "研究任务", group: CALLER },
  "overrides.extract_model": { label: "提取模型", group: OVERRIDE },
  "overrides.research_model": { label: "研究模型", group: OVERRIDE },
  "overrides.pin": { label: "固定引擎", group: OVERRIDE },
  "overrides.no_cache": { label: "不读缓存", group: OVERRIDE, format: yes },
  "overrides.route.provider": { label: "指定提供商", group: OVERRIDE },
  "overrides.research.max_steps": { label: "步数上限", group: OVERRIDE, format: number },
  "overrides.research.max_duration_seconds": { label: "时长上限", group: OVERRIDE, format: (v) => `${v}s` },
  "overrides.research.max_tokens": { label: "Token 上限", group: OVERRIDE, format: number },
  "overrides.research.max_context_tokens": { label: "上下文上限", group: OVERRIDE, format: number },
  "overrides.research.reading": { label: "读取方式", group: OVERRIDE, format: from({ raw: "读原文", extract: "读归纳" }) },
  "overrides.research.quick": { label: "快速研究", group: OVERRIDE, format: yes },
  "policy.extract_models": { label: "提取模型", group: POLICY },
  "policy.research_model": { label: "研究模型", group: POLICY },
  "policy.max_steps": { label: "步数上限", group: POLICY, format: number },
  "policy.max_duration_seconds": { label: "时长上限", group: POLICY, format: (v) => `${v}s` },
  "policy.max_tokens": { label: "Token 上限", group: POLICY, format: number },
  "policy.quick_only": { label: "只许快速研究", group: POLICY, format: yes },

  hit: { label: "有缓存", format: yes },
  reason: { label: "原因", format: from({ ...cacheMiss, ...skipReason }) },
  engine: { label: "引擎" },
  bytes: { label: "大小", format: size },
  mode: { label: "方式", format: from(routeMode) },
  "rule.name": { label: "名称", group: RULE },
  "rule.pattern": { label: "命中的模式", group: RULE },
  "rule.builtin": { label: "内置规则", group: RULE, format: yes },

  kind: { label: "类型", format: from({ ...toolLabel, text: "正文", answer: "回答", error: "错误" }) },
  target: { label: "目标" },
  timeout_ms: { label: "超时", format: ms },
  slow_threshold_ms: { label: "慢请求阈值", format: ms },
  rate_strategy: { label: "遇到限速", format: from({ wait: "等配额", fallback: "换下一个" }) },
  gone_after: { label: "判定失效需要", format: (v) => `${v} 个提供商确认` },
  winner: { label: "胜出" },
  trigger: { label: "触发", format: from(triggerName) },
  try: { label: "第几次", format: number },
  max_tries: { label: "最多几次", format: number },
  results: { label: "结果数", format: number },
  error_class: { label: "错误类别" },
  breaker: { label: "熔断器", format: from({ failure: "记一次失败", disabled: "已停用这个提供商" }) },
  until_ms: { label: "恢复时间", format: until },
  wait_ms: { label: "需等待", format: ms },
  provider: { label: "提供商" },
  worker_id: { label: "Worker ID" },
  profile: { label: "浏览器 Profile" },
  adapter: { label: "站点适配器" },
  title: { label: "标题" },
  rendered: { label: "渲染后的页面", format: yes },
  cached: { label: "来自缓存", format: yes },
  offset: { label: "起始位置", format: number },
  length: { label: "要求长度", format: number },
  passthrough_length: { label: "原样返回的阈值", format: number },
  raw_page_length: { label: "正文长度", format: number },

  models: { label: "模型顺序" },
  range: { label: "交给模型的区间", format: (v) => (Array.isArray(v) ? `${count(Number(v[0]))} – ${count(Number(v[1]))}` : String(v)) },
  excerpt: { label: "只取片段", format: yes },
  max_input_length: { label: "输入上限", format: number },
  custom_prompt: { label: "自定义提示词", format: (v) => (typeof v === "boolean" ? yes(v, {} as TraceNode) : String(v)) },
  raw_on_failure: { label: "失败时返回原文", format: yes },
  fallback: { label: "最终", format: from({ raw: "模型都失败，返回原文" }) },

  model: { label: "模型名", group: PARAMS },
  api: { label: "接口", group: PARAMS },
  role: { label: "用途", group: PARAMS, format: from({ extract: "提取", research: "研究" }) },
  "reasoning.mode": { label: "推理", group: PARAMS, format: from({ off: "关闭", effort: "按强度", budget: "按预算" }) },
  "reasoning.effort": { label: "推理强度", group: PARAMS },
  "reasoning.budget_tokens": { label: "推理预算", group: PARAMS, format: number },
  max_output_tokens: { label: "最大输出", group: PARAMS, format: number },
  first_chunk_timeout_ms: { label: "首包超时", group: PARAMS, format: ms },
  total_timeout_ms: { label: "总超时", group: PARAMS, format: ms },
  reading: { label: "阅读方式", group: PARAMS, format: from({ raw: "自己读原文", extract: "由提取模型代读" }) },
  tools: { label: "可用工具", group: PARAMS },
  "budget.max_steps": { label: "步数", group: BUDGET, format: number },
  "budget.max_duration_seconds": { label: "时长", group: BUDGET, format: (v) => `${v}s` },
  "budget.max_tokens": { label: "Token", group: BUDGET, format: number },
  "budget.max_context_tokens": { label: "上下文", group: BUDGET, format: number },

  "usage.input_tokens": { label: "输入", group: USAGE, format: number },
  "usage.output_tokens": { label: "输出", group: USAGE, format: number },
  "usage.cache_read_tokens": { label: "读缓存", group: USAGE, format: number },
  "usage.cache_write_tokens": { label: "写缓存", group: USAGE, format: number },
  first_chunk_ms: { label: "首包耗时", group: USAGE, format: ms },
  llm_ms: { label: "模型耗时", group: USAGE, format: ms },
  context_tokens: { label: "上下文", group: USAGE, format: number },
  finish_reason: { label: "结束原因", group: USAGE },
  truncated: { label: "被截断", format: yes },
  exhausted: { label: "预算用尽", format: yes },
  steps: { label: "步数", format: number },
  final: { label: "写报告的一轮", format: yes },

  text_length: { label: "返回长度", format: number },
  next_offset: { label: "下一页起点", format: number },
  warning: { label: "提示" },
  queries: { label: "查询数", format: number },
  ok: { label: "成功", format: number },
  failed: { label: "失败", format: number },
  items: { label: "结果数", format: number },
  web: { label: "网页", format: number },
  videos: { label: "视频", format: number },
  filtered: { label: "过滤", format: number },
  deduped: { label: "去重", format: number },
  total: { label: "合计", format: number },
  report_bytes: { label: "报告大小", format: size },
  searches: { label: "搜索", format: number },
  dev_searches: { label: "开发搜索", format: number },
  fetches: { label: "抓取", format: number },
  read: { label: "读过的页面", format: number },
  unread: { label: "未读的页面", format: number },
};

/** Attributes drawn by the panel itself, or of no use to a reader. */
const hidden = new Set(["candidates", "legacy", "note", "args"]);
/** Objects whose fields are facts of their own. */
const flattened = new Set(["usage", "reasoning", "budget", "rule", "policy", "overrides", "overrides.route", "overrides.research"]);

export interface FactGroup {
  title?: string;
  rows: { key: string; label: string; value: string; known: boolean }[];
}

export interface NodeFacts {
  groups: FactGroup[];
  /** Structured values shown as they are: arguments, options, request bodies. */
  blocks: { key: string; label: string; json: string }[];
}

const blockLabel: Record<string, string> = {
  options: "提供商参数",
  extra_body: "extra_body",
  "overrides.route.options": "指定路由的参数",
  "overrides.route.extra_body": "指定路由的 extra_body",
};

export function factsOf(node: TraceNode): NodeFacts {
  const groups = new Map<string, FactGroup>();
  const blocks: NodeFacts["blocks"] = [];
  const row = (key: string, value: unknown) => {
    if (value == null || value === "") return;
    const fact = facts[key];
    const list = Array.isArray(value) && value.every((v) => typeof v !== "object");
    if (typeof value === "object" && !list && !fact?.format) {
      if (Array.isArray(value) ? value.length : Object.keys(value as object).length) {
        blocks.push({ key, label: blockLabel[key] ?? fact?.label ?? key, json: JSON.stringify(value, null, 2) });
      }
      return;
    }
    const title = fact?.group ?? "";
    if (!groups.has(title)) groups.set(title, { title: title || undefined, rows: [] });
    groups.get(title)!.rows.push({
      key,
      label: fact?.label ?? key,
      value: fact?.format ? fact.format(value, node) : list ? (value as unknown[]).join(" → ") : typeof value === "boolean" ? yes(value, node) : String(value),
      known: !!fact,
    });
  };
  const walk = (prefix: string, attrs: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(attrs)) {
      const key = prefix + name;
      if (hidden.has(key)) continue;
      if (flattened.has(key) && value && typeof value === "object" && !Array.isArray(value)) walk(`${key}.`, value as Record<string, unknown>);
      else row(key, value);
    }
  };
  walk("", node.attrs ?? {});
  // The group without a title reads first: it is what the node itself is about.
  const ordered = [...groups.values()].sort((a, b) => Number(!!a.title) - Number(!!b.title));
  return { groups: ordered, blocks };
}

export { stoppedHere } from "../../lib/api";
