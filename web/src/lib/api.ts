// Types and calls of the management API (internal/admin).

export interface Secret {
  api_key: string;
  api_key_hint?: string;
  clear_api_key?: boolean;
}

export interface Provider extends Secret {
  base_url?: string;
}

export interface Route {
  provider: string;
  enabled: boolean;
  rate_limit: string;
  concurrency: number;
  /** The provider's parameters for this tool that differ from the declared defaults. */
  options?: Record<string, unknown>;
  /** Merged into the request last. */
  extra_body?: Record<string, unknown>;
}

/** How much a model thinks before answering. An empty mode leaves it to the model. */
export interface Reasoning {
  mode: "" | "off" | "effort" | "budget";
  effort?: string;
  budget_tokens?: number;
}

/** A model of an LLM provider. Features refer to it by `id`, unique across providers. */
export interface Model {
  id: string;
  /** The model name sent to the API. */
  name: string;
  max_output_tokens?: number;
  reasoning: Reasoning;
  /** Merged into the request last, so it overrides `reasoning`. */
  extra_body?: Record<string, unknown>;
  rate_limit: string;
  concurrency: number;
}

export interface Extract {
  /** Model ids in failover order. */
  models: string[];
  raw_on_failure: boolean;
  system_prompt?: string;
  max_input_length: number;
  max_output_tokens?: number;
  first_chunk_timeout_ms: number;
  max_retries: number;
  stream_total_timeout_ms: number;
}

export type LLMType = "openai-compatible" | "anthropic";

export interface LLMProvider extends Secret {
  id: string;
  name: string;
  type: LLMType;
  base_url: string;
  headers?: Record<string, string>;
  models: Model[];
}

export interface Research {
  enabled: boolean;
  /** The id of the single model research runs on. */
  model: string;
  /** Whether the agent reads page text itself or has the extract models answer per page. */
  reading: "raw" | "extract";
  system_prompt?: string;
  max_steps: number;
  max_duration_seconds: number;
  max_tokens: number;
  max_context_tokens: number;
}

export interface Config {
  providers: Record<string, Provider>;
  search: { timeout_seconds: number; country?: string; language?: string; routes: Route[] };
  fetch: {
    timeout_seconds: number;
    slow_threshold_seconds: number;
    smart_fallback: boolean;
    cache_ttl_seconds: number;
    passthrough_length: number;
    raw_page_length: number;
    routes: Route[];
    extract: Extract;
  };
  llm: { providers: LLMProvider[] };
  research: Research;
  /** One circuit-breaker policy for every provider and extract model. */
  breaker: { enabled: boolean; failures: number; window_seconds: number; cooldown_seconds: number };
  logs: { retention_days: number; max_rows: number; capture_body: boolean };
  network: { proxy?: string };
}

export type Tool = "search" | "fetch" | "research";

export interface ProviderInfo {
  id: string;
  name: string;
  website: string;
  key_required: boolean;
  default_base_url: Record<string, string>;
  default_rate_limit: Record<string, string>;
  /** Keyed by tool. */
  options?: Record<string, ProviderOption[]>;
}

/** One parameter of a provider for a tool; a null default leaves it out of the request. */
export interface ProviderOption {
  key: string;
  type: "bool" | "int" | "enum" | "string";
  default: unknown;
  values?: string[];
  min?: number;
  max?: number;
  format?: "country" | "language";
}

export interface Meta {
  version: string;
  catalog: ProviderInfo[];
  tools: Tool[];
  defaults: Config;
  /** The reasoning effort levels each API format accepts. */
  reasoning_efforts: Record<LLMType, string[]>;
  prompts: { extract: string; research: string };
}

export interface APIKey {
  id: number;
  name: string;
  prefix: string;
  scopes: Tool[];
  rate_limit: string;
  created_at: number;
  last_used_at?: number;
  revoked_at?: number;
}

export interface Attempt {
  kind: string;
  provider: string;
  target?: string;
  /** `skipped`: switched off by the breaker; `limited`: no free rate-limit slot at the time. */
  status: "ok" | "error" | "canceled" | "cached" | "skipped" | "limited";
  start_ms: number;
  duration_ms: number;
  http_status?: number;
  error?: string;
}

export interface Hop {
  kind: string;
  provider: string;
  status: Attempt["status"];
  count: number;
}

export interface LogEntry {
  id: number;
  ts: number;
  tool: Tool;
  source: "mcp" | "webui";
  api_key_id?: number;
  api_key_name?: string;
  status: "ok" | "error";
  duration_ms: number;
  provider?: string;
  summary: string;
  error?: string;
  input_tokens: number;
  output_tokens: number;
  /** The parts of input_tokens read from, and written to, the prompt cache. */
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  attempts?: Attempt[];
  /** The route of a call that did not go straight through; absent otherwise. */
  hops?: Hop[];
  request?: string;
  response?: string;
}

export interface ToolStats {
  tool: Tool;
  calls: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
}

export interface ProviderStats {
  kind: string;
  provider: string;
  calls: number;
  errors: number;
  canceled: number;
  wins: number;
  p50_ms: number;
  p95_ms: number;
}

/** What the circuit breaker says about a provider or model. */
export interface Health {
  disabled: boolean;
  /** Repeated failures ("provider"), a rejected key or spent credits. */
  disabled_reason?: "provider" | "auth" | "quota";
  /** How much longer it stays off; 0 while disabled means until it is re-enabled. */
  disabled_ms: number;
  /** What the upstream answered, for a rejected key or spent credits. */
  disabled_detail?: string;
}

export interface RouteStatus extends Health {
  key: string;
  tool: Tool;
  provider: string;
  available: boolean;
  enabled: boolean;
  rate_limit: string;
  used: number;
  limit: number;
  active: number;
  concurrency: number;
}

export interface ModelStatus extends Health {
  key: string;
  id: string;
  provider: string;
  name: string;
  rate_limit: string;
  used: number;
  limit: number;
  active: number;
  concurrency: number;
  roles: ("extract" | "research")[];
}

export interface Overview {
  stats: {
    since: number;
    tools: ToolStats[];
    providers: ProviderStats[];
    buckets: { ts: number; calls: number; errors: number }[];
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  routes: RouteStatus[];
  models: ModelStatus[];
  cache: { pages: number; bytes: number };
  roles: { extract: boolean; research: boolean };
}

/** The arguments of the search tool, as an MCP client sends them. */
export interface SearchArgs {
  queries: string[];
  maxResults?: number;
  time_range?: string;
  include_domains?: string[];
  exclude_domains?: string[];
  search_engine?: string;
}

/** The arguments of the fetch tool, as an MCP client sends them. */
export interface FetchArgs {
  url: string;
  prompt: string;
  raw?: boolean;
  offset?: number;
  fetch_engine?: string;
}

export interface SearchItem {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  duration?: string;
  score?: number;
}

export interface SearchResult {
  search_engine?: string;
  query: string;
  web?: SearchItem[];
  videos?: SearchItem[];
  error?: string;
}

export interface FetchResult {
  title?: string;
  description?: string;
  content?: string;
  fetch_engine?: string;
  error?: string;
  content_length?: number;
  next_offset?: number;
  answer?: string;
  answer_truncated?: boolean;
  covered?: [number, number];
  warning?: string;
}

export interface ResearchResult {
  report: string;
  steps: number;
  budget_exhausted?: boolean;
  searches: number;
  fetches: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface ResearchTask {
  id: string;
  created_at: number;
  updated_at: number;
  status: "running" | "done" | "failed";
  question: string;
  progress?: string;
  result?: string;
  error?: string;
}

export class APIError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Called when a request finds the session gone, so the app can show the login screen. */
let onUnauthorized = () => {};
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

async function request<T>(method: string, path: string, body?: unknown, raw?: string): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (raw !== undefined) {
    init.body = raw;
    init.headers = { "Content-Type": "text/plain" };
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new APIError("无法连接到服务器", 0);
  }
  if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized();
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const message = (data as { error?: string } | undefined)?.error ?? (text.trim() || `HTTP ${res.status}`);
    throw new APIError(message, res.status);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});

export const api = {
  authState: () => get<{ setup_required: boolean; authenticated: boolean }>("/api/auth/state"),
  login: (password: string) => post("/api/auth/login", { password }),
  setup: (token: string, password: string) => post("/api/auth/setup", { token, password }),
  logout: () => post("/api/auth/logout"),
  changePassword: (current: string, next: string) => post("/api/auth/password", { current, new: next }),

  meta: () => get<Meta>("/api/meta"),
  config: () => get<Config>("/api/config"),
  saveConfig: (config: Config) => request<Config>("PUT", "/api/config", config),
  importConfig: (yaml: string) => request<Config>("POST", "/api/config/import", undefined, yaml),

  keys: () => get<APIKey[]>("/api/keys"),
  createKey: (body: { name: string; scopes: Tool[]; rate_limit: string }) =>
    post<{ key: APIKey; secret: string }>("/api/keys", body),
  updateKey: (id: number, body: { name: string; scopes: Tool[]; rate_limit: string }) =>
    request("PATCH", `/api/keys/${id}`, body),
  revokeKey: (id: number) => post(`/api/keys/${id}/revoke`),
  deleteKey: (id: number) => request("DELETE", `/api/keys/${id}`),

  logs: (params: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return get<LogEntry[]>(`/api/logs?${query}`);
  },
  log: (id: number) => get<LogEntry>(`/api/logs/${id}`),
  clearLogs: () => request("DELETE", "/api/logs"),
  overview: (window: string) => get<Overview>(`/api/stats?window=${window}`),
  clearCache: () => post("/api/cache/clear"),
  status: () => get<{ routes: RouteStatus[]; models: ModelStatus[] }>("/api/status"),
  resetBreaker: (key: string) => post("/api/breaker/reset", { key }),

  playSearch: (body: SearchArgs) => post<{ duration_ms: number; results: SearchResult[]; attempts: Attempt[] | null }>("/api/play/search", body),
  /** `model` answers in place of the extract chain, for this call only. */
  playFetch: (body: FetchArgs & { model?: string }) => post<{ duration_ms: number; result: FetchResult; attempts: Attempt[] | null }>("/api/play/fetch", body),
  playModel: (provider: LLMProvider, model: Model) =>
    post<{ duration_ms: number; reply: string }>("/api/play/model", { provider, model }),
  /** `model` runs the agent in place of the configured model, for this task only. */
  startResearch: (body: { question: string; model?: string }) => post<{ task_id: string }>("/api/research/tasks", body),
  researchTask: (id: string) => get<ResearchTask>(`/api/research/tasks/${id}`),
};
