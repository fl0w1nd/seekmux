// Types and calls of the management API (internal/admin).

export interface Secret {
  api_key: string;
  api_key_hint?: string;
  clear_api_key?: boolean;
}

export interface Provider extends Secret {
  base_url?: string;
  /** Shared by every tool the provider serves; empty means unlimited. */
  rate_limit: string;
  /** 0 means unlimited. */
  concurrency: number;
}

/**
 * A self-hosted fetcher: workers on the user's own devices that the fetch
 * routes and the routing rules see as one provider, whose id is the
 * fetcher's. A fetch goes to the first worker that can take it.
 */
export interface Fetcher {
  id: string;
  /** One of Meta.fetcher_types. */
  type: string;
  name: string;
  /** Bounds the fetcher as a whole; empty means unlimited. */
  rate_limit: string;
  /** 0 means unlimited. */
  concurrency: number;
  workers: FetcherWorker[];
}

/** One device of a fetcher. */
export interface FetcherWorker {
  id: string;
  name: string;
  enabled: boolean;
  /** Sent only when set or changed; the server answers with token_hint. */
  token: string;
  token_hint?: string;
  /** The Chrome profile it reads with, by OpenCLI context id; empty leaves it to OpenCLI. */
  profile?: string;
}

/** The software a fetcher's workers run. */
export interface FetcherType {
  id: string;
  name: string;
  website: string;
  default_rate_limit: string;
  /** Built-in routing rules whose pages it reads through a site adapter of its own. */
  adapters?: string[];
}

export interface Route {
  provider: string;
  enabled: boolean;
  /** Keeps it out of the tool's slow-request race (fetch only for now); absent means it races. */
  no_hedge?: boolean;
  /** The provider's parameters for this tool that differ from the declared defaults. */
  options?: Record<string, unknown>;
  /** Merged into the request last. */
  extra_body?: Record<string, unknown>;
}

/**
 * Sends the pages it matches to its own providers in place of the fetch
 * routes. A provider serves a rule whenever it has its credentials.
 */
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /** Patterns of the form host[/path-prefix]; a host stands for its subdomains too. */
  match: string[];
  providers: string[];
  /** Has a built-in URL pattern; never set on a stored rule. */
  builtin?: boolean;
}

/** The user's providers and switch for a built-in rule. */
export interface BuiltinRule {
  enabled?: boolean;
  /** Tried in order when the rule is enabled. */
  providers?: string[];
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
  /** How long one research_result call waits for a running task. */
  result_wait_seconds: number;
}

export interface Config {
  providers: Record<string, Provider>;
  fetchers: Fetcher[];
  search: { timeout_seconds: number; country?: string; language?: string; routes: Route[] };
  dev_search: { timeout_seconds: number; routes: Route[] };
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
  social: Social;
  /** `rules` are tried in order, ahead of the built-in ones; `builtin` is keyed by rule id. */
  routing: { rules: Rule[]; builtin?: Record<string, BuiltinRule> };
  llm: { providers: LLMProvider[] };
  research: Research;
  /** One circuit-breaker policy for every provider and extract model. */
  breaker: { enabled: boolean; failures: number; window_seconds: number; cooldown_seconds: number };
  logs: { retention_days: number; max_rows: number; capture_body: boolean };
  network: { proxy?: string; public_url?: string };
  /** MCP clients may sign in instead of presenting an API key, unless switched off. */
  oauth: { disabled?: boolean };
}

/** The social platforms the x_search tool and its kin search, each through the workers of a self-hosted fetcher. */
export interface Social {
  timeout_seconds: number;
  sources: SocialSource[];
}

export interface SocialSource {
  /** One of Meta.social_platforms. */
  platform: string;
  enabled: boolean;
  /** The self-hosted fetcher whose workers search the platform; "" while none is chosen. */
  fetcher: string;
  /** Its workers that search the platform, tried in the fetcher's order. */
  workers: string[];
}

export interface SocialPlatform {
  id: string;
  name: string;
  tool: Tool;
  fetcher_type: string;
  /** What a worker announces when it can search the platform, from version min_worker on. */
  feature: string;
  min_worker: string;
}

export type Tool = "search" | "dev_search" | "fetch" | "x_search" | "research";

/** The tools served by a priority list of providers. */
export type RoutedTool = "search" | "dev_search" | "fetch";

export interface ProviderInfo {
  id: string;
  name: string;
  website: string;
  key_required: boolean;
  /** The tools the provider serves. */
  tools: RoutedTool[];
  /** Keyed by tool. */
  default_base_url: Record<string, string>;
  default_rate_limit: string;
  /** Keyed by tool. */
  options?: Record<string, ProviderOption[]>;
  default_concurrency?: number;
  /** The type of a self-hosted fetcher; absent for a built-in provider. */
  fetcher?: string;
  /** Built-in routing rules whose pages it reads through a site adapter of its own. */
  adapters?: string[];
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
  fetcher_types: FetcherType[];
  social_platforms: SocialPlatform[];
  /** The built-in routing rules, before the configuration changes them. */
  rules: Rule[];
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
  /** When the key stops working, in ms; absent means never. */
  expires_at?: number;
  policy: KeyPolicy;
  /** The OAuth client the key stands for; such a key has no secret, the client calls with tokens. */
  oauth_client?: string;
}

/** An authorization request as an MCP client put it in the address of the approval page. */
export interface OAuthRequest {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
}

/** What the admin is asked to approve; `redirect` alone when the request can only go back to the client. */
export interface OAuthPrompt {
  redirect?: string;
  client_name?: string;
  client_uri?: string;
  redirect_uri?: string;
  scopes?: Tool[];
  /** The name of the key the client already calls with. */
  key?: string;
}

/** What a key changes about the calls it makes; an empty policy changes nothing. */
export interface KeyPolicy {
  /** Replaces the extract chain, in order. */
  extract_models?: string[];
  /** Replaces the model of the research agent. */
  research_model?: string;
  research: {
    /** Ceilings on the configured budget; absent or 0 leaves it. */
    max_steps?: number;
    max_duration_seconds?: number;
    max_tokens?: number;
    /** Every run is a quick one. */
    quick_only?: boolean;
    /** How many runs the key may have under way at once. */
    concurrency?: number;
  };
}

export interface KeyBody {
  name: string;
  scopes: Tool[];
  rate_limit: string;
  expires_at: number;
  policy: KeyPolicy;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface UsageCount extends Usage {
  calls: number;
  errors: number;
}

/** What one key used over a number of days. */
export interface KeyUsage {
  /** The tool calls and every token. */
  total: UsageCount;
  /** One entry per day, oldest first; `ts` is midnight UTC. */
  days: (UsageCount & { ts: number })[];
  tools: (UsageCount & { tool: Tool })[];
  /** Upstream requests by the kind of call they were made for. */
  providers: { kind: RoutedTool; provider: string; calls: number; errors: number }[];
  models: (UsageCount & { model: string })[];
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

/** How a node of a call's trace stands; `running` only while the call is live. */
export type NodeStatus = "running" | "ok" | "error" | "canceled" | "cached" | "skipped" | "limited";

/**
 * One node of the trace of a call: a decision the gateway made or a call it
 * placed, under the node it was made for. Node 1 is the call itself.
 */
export interface TraceNode {
  id: number;
  /** 0 or absent for the root. */
  parent?: number;
  kind: string;
  name?: string;
  status: NodeStatus;
  /** Since the call began. */
  start_ms: number;
  /** 0 or absent while running, and for a decision, which takes no time. */
  duration_ms?: number;
  http_status?: number;
  error?: string;
  attrs?: Record<string, unknown>;
}

/** A running node of a call in flight that has no running node under it. */
export interface ActiveNode {
  id: number;
  kind: string;
  name?: string;
  start_ms: number;
}

/** A tool call that has not ended yet. */
export interface LiveCall {
  call_id: string;
  tool: Tool;
  source: "mcp" | "webui";
  api_key_id?: number;
  api_key_name?: string;
  client_ip?: string;
  user_agent?: string;
  summary: string;
  task_id?: string;
  started_at: number;
  /** The research step under way. */
  step?: number;
  active?: ActiveNode[];
  nodes?: number;
}

/** How a call in flight ended. */
export interface LiveDone {
  call_id?: string;
  status: "ok" | "error" | "canceled";
  duration_ms: number;
  error?: string;
}

/** The text a model has written so far, by the id of its node. */
export type TraceText = Record<string, string>;

export interface Hop {
  kind: string;
  provider: string;
  status: Attempt["status"];
  count: number;
}

export interface LogEntry {
  id: number;
  /** The id the call had while it ran; absent on entries from before calls had one. */
  call_id?: string;
  ts: number;
  tool: Tool;
  source: "mcp" | "webui";
  api_key_id?: number;
  api_key_name?: string;
  client_ip?: string;
  user_agent?: string;
  /** The research task a research call ran as; its report has a page. */
  task_id?: string;
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
  /** How the call was decided and served; only on a single entry, absent on entries from before traces. */
  trace?: TraceNode[];
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

/** The tool calls of one caller: an API key, or the playground when it has no key. */
export interface CallerStats {
  source: string;
  api_key_id?: number;
  api_key_name?: string;
  calls: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  /** The number of client addresses the calls came from. */
  ips: number;
  input_tokens: number;
  output_tokens: number;
}

/** Failed upstream attempts of one provider and kind that ended with the same HTTP status. */
export interface ErrorStats {
  kind: string;
  provider: string;
  http_status?: number;
  count: number;
  /** The error of the latest of them. */
  sample: string;
  last_ts: number;
}

/** How a provider's attempt at a page ended; `missing` is the site saying the page does not exist. */
export type FetchOutcome = "ok" | "blocked" | "missing" | "failed" | "timeout";

/** What one provider made of the pages of a domain. */
export interface DomainProviderStats {
  provider: string;
  calls: number;
  outcomes: Partial<Record<FetchOutcome, number>>;
  /** The mean duration and text size of the pages it read. */
  avg_ms: number;
  avg_bytes: number;
}

export interface DomainStats {
  /** The registrable domain, e.g. youtube.com for m.youtube.com. */
  domain: string;
  calls: number;
  outcomes: Partial<Record<FetchOutcome, number>>;
  providers: DomainProviderStats[];
}

/** What the circuit breaker says about a provider or model. */
export interface Health {
  disabled: boolean;
  /** Repeated failures ("provider"), a rejected key, spent credits, or a setup to fix outside the gateway. */
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

/** A Chrome profile OpenCLI knows on the worker. */
export interface WorkerProfile {
  id: string;
  alias?: string;
  default?: boolean;
  connected: boolean;
}

/** A worker connected to the gateway. */
export interface WorkerStatus {
  connected: boolean;
  version?: string;
  /** What it announced it can do beyond reading pages, such as x_search. */
  features?: string[];
  slots?: number;
  active: number;
  addr?: string;
  /** When it connected, in Unix milliseconds. */
  since?: number;
  state?: { ready: boolean; problem?: string; opencli?: string; profiles: WorkerProfile[] };
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
    callers: CallerStats[];
    buckets: { ts: number; calls: number; errors: number; tools: Partial<Record<Tool, number>> }[];
    errors: ErrorStats[];
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

/** The arguments of the dev_search tool, as an MCP client sends them. */
export interface DevSearchArgs {
  query: string;
  maxResults?: number;
  types?: string[];
  repos?: string[];
}

export interface DevSearchItem {
  type?: string;
  title?: string;
  url?: string;
  /** The parts of the document that matched, as markdown. */
  passages?: string[];
}

export interface DevSearchResult {
  search_engine?: string;
  query: string;
  results: DevSearchItem[];
  error?: string;
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
  text?: string;
  fetch_engine?: string;
  error?: string;
  text_length?: number;
  /** Logged before the keys were renamed: text and text_length. */
  content?: string;
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
  /** The limit that made the agent stop and report. */
  exhausted?: ResearchLimit;
  searches: number;
  /** Calls to dev_search; absent when there were none. */
  dev_searches?: number;
  fetches: number;
  /** The pages the agent read. */
  read?: string[];
  /** URLs the report cites although the agent never had their text. */
  unread?: string[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** What a research task runs on: the configuration with the overrides of its run applied. */
export interface ResearchBudget {
  model: string;
  reading: Research["reading"];
  max_steps: number;
  max_duration_seconds: number;
  max_tokens: number;
  max_context_tokens: number;
}

export type ResearchLimit = "steps" | "duration" | "tokens" | "context";

/** How much of its budget a research task has used so far. */
export interface ResearchSpent {
  /** The model rounds begun, the one under way included. */
  steps: number;
  searches: number;
  /** Calls to dev_search; absent when there were none. */
  dev_searches?: number;
  fetches: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** An estimate of the size of the next request to the model. */
  context_tokens: number;
  /** The limit that made the agent stop and report. */
  exhausted?: ResearchLimit;
}

/** A research task as the list gives it: without report, steps and draft. */
export interface ResearchTaskSummary {
  id: string;
  created_at: number;
  updated_at: number;
  status: "running" | "done" | "failed" | "canceled";
  question: string;
  progress?: string;
  error?: string;
  /** Set once the run has finished. */
  stats?: Omit<ResearchResult, "report">;
  /** Absent on a task started before budgets were recorded. */
  budget?: ResearchBudget;
  spent?: ResearchSpent;
}

export interface ResearchTask extends ResearchTaskSummary {
  result?: string;
  steps: ResearchStep[];
  /** The text the model is writing in its current step. */
  draft?: string;
  /** The server's clock when it answered, in ms. */
  now: number;
  /** The page that shows the report to anyone who has the link. */
  report_url: string;
  /** The call of the run while it is in flight, whose trace can be followed. */
  call_id?: string;
  /** The request log entry of the run once it is written, which holds its trace. */
  log_id?: number;
}

/** A research task as the page of its report shows it, to readers who are not signed in. */
export interface PublicReport {
  id: string;
  status: ResearchTaskSummary["status"];
  question: string;
  created_at: number;
  /** 0 while the task is running. */
  finished_at: number;
  /** When the task and its report are dropped. */
  expires_at: number;
  /** Empty unless the task is done. */
  report: string;
  searches: number;
  /** The pages the agent read, in the order it opened them. */
  read: string[];
  /** The links the report cites although the agent never read them. */
  unread: string[];
  /** The budget ran out before the agent was done. */
  cut_short: boolean;
}

/**
 * One thing the agent did, timed in ms from created_at. A task recorded
 * before steps had a kind carries `line` instead of the other fields.
 */
export interface ResearchStep {
  at: number;
  /** The model round it belongs to, from 1. */
  step?: number;
  kind?: "search" | "dev_search" | "fetch" | "note" | "wrap_up";
  text?: string;
  line?: string;
}

/** A provider's parameters for one tool, as a call from the console may replace them. */
export interface RouteTuning {
  provider: string;
  options?: Record<string, unknown>;
  extra_body?: Record<string, unknown>;
}

/** The limits of a research run that differ from the configured ones. */
export type BudgetOverride = Partial<Omit<ResearchBudget, "model">>;

/** What the gateway says of a call that was stopped from the console (app.ErrCallStopped). The log keeps it as a failure with these words. */
export const stoppedHere = "the call was stopped from the console";

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

/** What a playground call reports while it runs. */
export interface PlayEvents {
  onCall?: (callId: string) => void;
  onNode?: (node: TraceNode) => void;
  onText?: (node: number, delta: string) => void;
}

/** What every playground call answers with next to its result. */
export interface PlayRun {
  duration_ms: number;
  attempts: Attempt[] | null;
  call_id?: string;
  trace?: TraceNode[];
}

/**
 * Makes a playground call and follows it as it runs: the server answers with
 * one JSON object per line, the nodes of the trace as they change and the
 * result last. Aborting `signal` stops the call on the server as well.
 */
async function play<T>(path: string, body: unknown, events: PlayEvents = {}, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new APIError("已停止", 499);
    throw new APIError("无法连接到服务器", 0);
  }
  if (res.status === 401) onUnauthorized();
  if (!res.ok || !res.body || !(res.headers.get("Content-Type") ?? "").includes("ndjson")) {
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) throw new APIError((data as { error?: string } | undefined)?.error ?? (text.trim() || `HTTP ${res.status}`), res.status);
    return data as T;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;
  const take = (line: string) => {
    if (line.trim() === "") return;
    const event = JSON.parse(line) as { call_id?: string; node?: TraceNode; text?: { node: number; delta: string }; result?: T; error?: string };
    if (event.call_id) events.onCall?.(event.call_id);
    if (event.node) events.onNode?.(event.node);
    if (event.text) events.onText?.(event.text.node, event.text.delta);
    // A call stopped from the console ends as one stopped here does.
    if (event.error === stoppedHere) throw new APIError("已停止", 499);
    if (event.error !== undefined) throw new APIError(event.error, 400);
    if (event.result !== undefined) result = event.result;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        take(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (done) break;
    }
    take(buffer);
  } catch (err) {
    if (err instanceof APIError) throw err;
    if (signal?.aborted) throw new APIError("已停止", 499);
    throw new APIError("与服务器的连接中断，调用结果未知", 0);
  }
  if (result === undefined) throw new APIError("服务器未返回结果", 0);
  return result;
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
  createKey: (body: KeyBody) => post<{ key: APIKey; secret: string }>("/api/keys", body),
  updateKey: (id: number, body: KeyBody) => request("PATCH", `/api/keys/${id}`, body),
  keysUsage: (days: number) => get<{ days: number; keys: Record<string, UsageCount> }>(`/api/keys/usage?days=${days}`),
  keyUsage: (id: number, days: number) =>
    get<{ days: number; retention_days: number; usage: KeyUsage }>(`/api/keys/${id}/usage?days=${days}`),
  revokeKey: (id: number) => post(`/api/keys/${id}/revoke`),
  deleteKey: (id: number) => request("DELETE", `/api/keys/${id}`),
  oauthDescribe: (body: OAuthRequest) => post<OAuthPrompt>("/api/oauth/describe", body),
  oauthDecide: (body: OAuthRequest & { approve: boolean; scopes: Tool[] }) => post<{ redirect: string }>("/api/oauth/decide", body),

  logs: (params: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return get<LogEntry[]>(`/api/logs?${query}`);
  },
  log: (id: number) => get<LogEntry>(`/api/logs/${id}`),
  /** The entry of a call by the id it ran under; 404 until it is written, a moment after the call ends. */
  logByCall: (callId: string) => get<LogEntry>(`/api/logs/call/${encodeURIComponent(callId)}`),
  /** The calls in flight, oldest first. */
  live: () => get<{ now: number; calls: LiveCall[] }>("/api/live"),
  /** Stops a call in flight, whoever made it. */
  cancelCall: (callId: string) => post(`/api/live/${encodeURIComponent(callId)}/cancel`),
  clearLogs: () => request("DELETE", "/api/logs"),
  overview: (window: string) => get<Overview>(`/api/stats?window=${window}`),
  clearCache: () => post("/api/cache/clear"),
  domains: (days: number) => get<{ days: number; retention_days: number; domains: DomainStats[] }>(`/api/domains?days=${days}`),
  clearDomains: () => request("DELETE", "/api/domains"),
  /** `workers` holds the connected workers, by worker id. */
  status: () => get<{ routes: RouteStatus[]; models: ModelStatus[]; workers: Record<string, WorkerStatus> }>("/api/status"),
  resetBreaker: (key: string) => post("/api/breaker/reset", { key }),

  /** `route` replaces a provider's parameters for this call only. */
  playSearch: (body: SearchArgs & { route?: RouteTuning }, events?: PlayEvents, signal?: AbortSignal) =>
    play<PlayRun & { results: SearchResult[] }>("/api/play/search", body, events, signal),
  /** `search_engine` leaves one provider to serve the call; the tool itself has no such argument. */
  playDevSearch: (body: DevSearchArgs & { search_engine?: string; route?: RouteTuning }, events?: PlayEvents, signal?: AbortSignal) =>
    play<PlayRun & { result: DevSearchResult }>("/api/play/dev_search", body, events, signal),
  /** `model` answers in place of the extract chain and `no_cache` reads the page anew, for this call only. */
  playFetch: (body: FetchArgs & { model?: string; no_cache?: boolean; route?: RouteTuning }, events?: PlayEvents, signal?: AbortSignal) =>
    play<PlayRun & { result: FetchResult }>("/api/play/fetch", body, events, signal),
  playModel: (provider: LLMProvider, model: Model) =>
    post<{ duration_ms: number; reply: string }>("/api/play/model", { provider, model }),
  /** `model` and `budget` replace the configured model and limits, for this task only. */
  startResearch: (body: { question: string; model?: string; budget?: BudgetOverride }) => post<{ task_id: string }>("/api/research/tasks", body),
  researchTasks: () => get<ResearchTaskSummary[]>("/api/research/tasks"),
  researchTask: (id: string) => get<ResearchTask>(`/api/research/tasks/${id}`),
  cancelResearch: (id: string) => post(`/api/research/tasks/${id}/cancel`),
  /** Needs no session: the id is the secret. */
  report: (id: string) => get<PublicReport>(`/api/reports/${encodeURIComponent(id)}`),
};
