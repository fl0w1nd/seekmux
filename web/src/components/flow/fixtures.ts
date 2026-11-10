import type { TraceNode } from "../../lib/api";

/* Sample traces for the design page: the shapes a flow has to draw. */

type Draft = Omit<TraceNode, "id" | "parent"> & { children?: Draft[] };

/** Numbers a nested draft the way the gateway numbers a trace: in the order the nodes began. */
function number(root: Draft): TraceNode[] {
  const flat: { draft: Draft; parent?: Draft }[] = [];
  const walk = (draft: Draft, parent?: Draft) => {
    flat.push({ draft, parent });
    for (const child of draft.children ?? []) walk(child, draft);
  };
  walk(root);
  const order = flat.map((f, i) => ({ ...f, i })).sort((a, b) => a.draft.start_ms - b.draft.start_ms || a.i - b.i);
  const ids = new Map(order.map((f, i) => [f.draft, i + 1]));
  return order.map(({ draft, parent }) => {
    const { children: _, ...node } = draft;
    return { ...node, id: ids.get(draft)!, parent: parent ? ids.get(parent) : undefined };
  });
}

const llm = (name: string, role: string, more: Record<string, unknown> = {}) => ({
  provider: "openrouter",
  model: name,
  api: "openai-compatible",
  role,
  reasoning: { mode: "effort", effort: "low" },
  max_output_tokens: 4096,
  first_chunk_timeout_ms: 15_000,
  total_timeout_ms: 90_000,
  try: 1,
  max_tries: 2,
  ...more,
});

/** A fetch: cache miss, a race of two providers, then extraction that fails over to a second model. */
export const fetchTrace = number({
  kind: "call",
  name: "fetch",
  status: "ok",
  start_ms: 0,
  duration_ms: 9480,
  attrs: {
    source: "mcp",
    api_key_name: "claude-code",
    client_ip: "203.0.113.24",
    config_version: 41,
    args: { url: "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports", prompt: "Streamable HTTP 的会话是怎么建立和恢复的？" },
    overrides: { no_cache: false },
  },
  children: [
    { kind: "cache", name: "page", status: "ok", start_ms: 1, attrs: { hit: false, reason: "miss" } },
    { kind: "cache", name: "gone", status: "ok", start_ms: 1, attrs: { hit: false, reason: "miss" } },
    {
      kind: "route",
      status: "ok",
      start_ms: 2,
      attrs: {
        mode: "auto",
        candidates: [
          { provider: "firecrawl", eligible: true },
          { provider: "jina", eligible: true },
          { provider: "tavily", eligible: true },
          { provider: "exa", eligible: false, reason: "disabled" },
          { provider: "parallel", eligible: false, reason: "no_credentials" },
        ],
      },
    },
    {
      kind: "run",
      name: "hedged",
      status: "ok",
      start_ms: 2,
      duration_ms: 3310,
      attrs: { kind: "fetch", target: "modelcontextprotocol.io", timeout_ms: 30_000, slow_threshold_ms: 2000, rate_strategy: "fallback", gone_after: 2, winner: "jina" },
      children: [
        { kind: "attempt", name: "firecrawl", status: "canceled", start_ms: 3, duration_ms: 3308, attrs: { kind: "fetch", trigger: "first", try: 1, options: { formats: ["markdown"], only_main_content: true } } },
        { kind: "attempt", name: "jina", status: "ok", start_ms: 2004, duration_ms: 1306, http_status: 200, attrs: { kind: "fetch", trigger: "slow", try: 1, bytes: 48_211 } },
      ],
    },
    { kind: "page", status: "ok", start_ms: 3312, attrs: { engine: "jina", bytes: 48_211, title: "Transports – Model Context Protocol", rendered: false, cached: false } },
    { kind: "decide", name: "extract", status: "ok", start_ms: 3313, attrs: { offset: 0, length: 0, passthrough_length: 2000, raw_page_length: 31_870 } },
    {
      kind: "extract",
      status: "ok",
      start_ms: 3313,
      duration_ms: 6160,
      attrs: { models: ["gemini-flash", "gpt-mini"], range: [0, 31_870], excerpt: false, max_input_length: 120_000, max_output_tokens: 4096, custom_prompt: false, raw_on_failure: true },
      children: [
        { kind: "cache", name: "answer", status: "ok", start_ms: 3314, attrs: { hit: false, reason: "miss" } },
        {
          kind: "llm",
          name: "gemini-flash",
          status: "error",
          start_ms: 3315,
          duration_ms: 2140,
          http_status: 529,
          error: "upstream overloaded: the model is at capacity, try again later",
          attrs: llm("google/gemini-flash", "extract", { error_class: "provider", breaker: "failure" }),
        },
        {
          kind: "llm",
          name: "gpt-mini",
          status: "ok",
          start_ms: 5456,
          duration_ms: 4010,
          http_status: 200,
          attrs: llm("openai/gpt-mini", "extract", {
            trigger: "after_failure",
            usage: { input_tokens: 9820, output_tokens: 412, cache_read_tokens: 0, cache_write_tokens: 0 },
            first_chunk_ms: 640,
            finish_reason: "stop",
          }),
        },
      ],
    },
    { kind: "result", status: "ok", start_ms: 9479, attrs: { kind: "answer", bytes: 1620, text_length: 968 } },
  ],
});

export const fetchText: Record<string, string> = {
  [fetchTrace.find((n) => n.name === "gpt-mini")!.id]:
    "会话由服务端在 `InitializeResult` 的响应头里用 `Mcp-Session-Id` 建立：\n\n<copy lines=\"212-219\"/>\n\n客户端此后的每个请求都要带上这个头；服务端返回 404 表示会话已结束，客户端需要重新初始化。断线后用 `Last-Event-ID` 在 GET 流上续传。",
};

const searchRun = (start: number, attempts: Draft[], more: Record<string, unknown> = {}): Draft => ({
  kind: "run",
  name: "fallback",
  status: attempts.some((a) => a.status === "ok") ? "ok" : "error",
  start_ms: start,
  duration_ms: Math.max(...attempts.map((a) => a.start_ms + (a.duration_ms ?? 0))) - start,
  attrs: { kind: "search", timeout_ms: 15_000, rate_strategy: "fallback", ...more },
  children: attempts,
});

/** A search of three queries side by side: one passes a limited provider, one fails over. */
export const searchTrace = number({
  kind: "call",
  name: "search",
  status: "ok",
  start_ms: 0,
  duration_ms: 2260,
  attrs: { source: "webui", client_ip: "127.0.0.1", config_version: 41, args: { queries: ["MCP streamable http session", "Mcp-Session-Id header", "MCP SSE resumability Last-Event-ID"], max_results: 8 } },
  children: [
    {
      kind: "route",
      status: "ok",
      start_ms: 1,
      attrs: { mode: "auto", candidates: [{ provider: "brave", eligible: true }, { provider: "exa", eligible: true }, { provider: "tavily", eligible: true }, { provider: "perplexity", eligible: false, reason: "no_credentials" }] },
    },
    {
      kind: "query",
      name: "MCP streamable http session",
      status: "ok",
      start_ms: 2,
      duration_ms: 1180,
      attrs: { engine: "brave", web: 8 },
      children: [searchRun(2, [{ kind: "attempt", name: "brave", status: "ok", start_ms: 3, duration_ms: 1178, http_status: 200, attrs: { kind: "search", trigger: "first", try: 1, results: 8 } }], { winner: "brave" })],
    },
    {
      kind: "query",
      name: "Mcp-Session-Id header",
      status: "ok",
      start_ms: 2,
      duration_ms: 1420,
      attrs: { engine: "exa", web: 8 },
      children: [
        searchRun(
          2,
          [
            { kind: "attempt", name: "brave", status: "limited", start_ms: 3, error: "rate limit reached, next slot in 640ms", attrs: { kind: "search", wait_ms: 640 } },
            { kind: "attempt", name: "exa", status: "ok", start_ms: 4, duration_ms: 1418, http_status: 200, attrs: { kind: "search", trigger: "first", try: 1, results: 8 } },
          ],
          { winner: "exa" },
        ),
      ],
    },
    {
      kind: "query",
      name: "MCP SSE resumability Last-Event-ID",
      status: "ok",
      start_ms: 2,
      duration_ms: 2250,
      attrs: { engine: "tavily", web: 6 },
      children: [
        searchRun(
          2,
          [
            { kind: "attempt", name: "brave", status: "limited", start_ms: 3, error: "rate limit reached, next slot in 640ms", attrs: { kind: "search", wait_ms: 640 } },
            { kind: "attempt", name: "exa", status: "error", start_ms: 4, duration_ms: 930, http_status: 502, error: "bad gateway", attrs: { kind: "search", trigger: "first", try: 1, error_class: "provider", breaker: "failure" } },
            { kind: "attempt", name: "tavily", status: "ok", start_ms: 936, duration_ms: 1316, http_status: 200, attrs: { kind: "search", trigger: "after_failure", try: 1, results: 6 } },
          ],
          { winner: "tavily" },
        ),
      ],
    },
    { kind: "merge", status: "ok", start_ms: 2254, attrs: { filtered: 1, deduped: 5, total: 16 } },
    { kind: "result", status: "ok", start_ms: 2259, attrs: { queries: 3, ok: 3, failed: 0, items: 16 } },
  ],
});

const tool = (name: string, start: number, took: number, args: Record<string, unknown>, children: Draft[] = [], more: Partial<Draft> = {}): Draft => ({
  kind: "tool",
  name,
  status: "ok",
  start_ms: start,
  duration_ms: took,
  attrs: { args },
  children,
  ...more,
});

const fetched = (start: number, took: number, engine: string, size: number): Draft[] => [
  { kind: "cache", name: "page", status: "ok", start_ms: start, attrs: { hit: false, reason: "miss" } },
  { kind: "route", status: "ok", start_ms: start + 1, attrs: { mode: "auto", candidates: [{ provider: "firecrawl", eligible: true }, { provider: "jina", eligible: true }] } },
  {
    kind: "run",
    name: "fallback",
    status: "ok",
    start_ms: start + 1,
    duration_ms: took - 3,
    attrs: { kind: "fetch", timeout_ms: 30_000, winner: engine },
    children: [{ kind: "attempt", name: engine, status: "ok", start_ms: start + 2, duration_ms: took - 4, http_status: 200, attrs: { kind: "fetch", trigger: "first", try: 1, bytes: size } }],
  },
  { kind: "page", status: "ok", start_ms: start + took - 2, attrs: { engine, bytes: size } },
  { kind: "decide", name: "raw", status: "ok", start_ms: start + took - 1, attrs: { offset: 0, length: 12_000 } },
  { kind: "result", status: "ok", start_ms: start + took, attrs: { kind: "text", text_length: 12_000, truncated: true, next_offset: 12_000 } },
];

/** A research run of three steps: searches side by side, pages read, one of them failing, then the report. */
export const researchTrace = number({
  kind: "call",
  name: "research",
  status: "ok",
  start_ms: 0,
  duration_ms: 48_300,
  attrs: { source: "mcp", api_key_name: "cursor", client_ip: "203.0.113.24", config_version: 41, task_id: "r_8f2c1a", args: { question: "MCP 的 Streamable HTTP 相比旧的 HTTP+SSE 传输改了什么，迁移要注意什么？", depth: "quick" } },
  children: [
    {
      kind: "agent",
      name: "claude-sonnet",
      status: "ok",
      start_ms: 4,
      duration_ms: 48_290,
      attrs: llm("anthropic/claude-sonnet", "research", {
        api: "anthropic",
        reasoning: { mode: "budget", budget_tokens: 4000 },
        budget: { max_steps: 12, max_duration_seconds: 300, max_tokens: 400_000, max_context_tokens: 150_000 },
        reading: "raw",
        tools: ["search", "fetch", "read_page"],
        usage: { input_tokens: 61_240, output_tokens: 3980, cache_read_tokens: 38_100, cache_write_tokens: 12_400 },
        steps: 3,
      }),
      children: [
        {
          kind: "step",
          name: "1",
          status: "ok",
          start_ms: 5,
          duration_ms: 6400,
          attrs: { context_tokens: 2100, usage: { input_tokens: 2100, output_tokens: 240 }, llm_ms: 3900, note: "先找规范原文和迁移说明，再看 SDK 的变更记录。" },
          children: [
            tool("search", 3910, 2480, { query: "MCP streamable HTTP vs HTTP+SSE transport changes" }, [
              { kind: "route", status: "ok", start_ms: 3911, attrs: { mode: "auto", candidates: [{ provider: "brave", eligible: true }, { provider: "exa", eligible: true }] } },
              {
                kind: "query",
                name: "MCP streamable HTTP vs HTTP+SSE transport changes",
                status: "ok",
                start_ms: 3912,
                duration_ms: 2470,
                attrs: { engine: "brave", web: 8 },
                children: [searchRun(3912, [{ kind: "attempt", name: "brave", status: "ok", start_ms: 3913, duration_ms: 2468, http_status: 200, attrs: { kind: "search", trigger: "first", results: 8 } }])],
              },
              { kind: "result", status: "ok", start_ms: 6388, attrs: { queries: 1, ok: 1, failed: 0, items: 8 } },
            ]),
            tool("search", 3912, 1900, { query: "MCP backwards compatibility deprecated SSE transport migration" }),
          ],
        },
        {
          kind: "step",
          name: "2",
          status: "ok",
          start_ms: 6410,
          duration_ms: 14_200,
          attrs: { context_tokens: 9800, usage: { input_tokens: 9800, output_tokens: 310 }, llm_ms: 4100, note: "规范的 transports 一章和 changelog 最相关，SDK 的迁移指南补充细节。" },
          children: [
            tool("fetch", 10_520, 3900, { url: "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports" }, fetched(10_520, 3900, "jina", 48_211)),
            tool("fetch", 10_521, 5200, { url: "https://modelcontextprotocol.io/specification/2025-06-18/changelog" }, fetched(10_521, 5200, "firecrawl", 12_044)),
            tool(
              "fetch",
              10_522,
              10_080,
              { url: "https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration.md" },
              [
                { kind: "route", status: "ok", start_ms: 10_523, attrs: { mode: "rule", rule: { name: "GitHub", builtin: true, pattern: "github.com" }, candidates: [{ provider: "jina", eligible: true }] } },
                {
                  kind: "run",
                  name: "single",
                  status: "error",
                  start_ms: 10_524,
                  duration_ms: 10_070,
                  attrs: { kind: "fetch", timeout_ms: 10_000 },
                  children: [{ kind: "attempt", name: "jina", status: "error", start_ms: 10_525, duration_ms: 10_068, error: "timeout after 10s", attrs: { kind: "fetch", trigger: "first", error_class: "timeout" } }],
                },
                { kind: "result", status: "error", start_ms: 10_600, error: "timeout after 10s", attrs: { kind: "error" } },
              ],
              { status: "error", error: "jina: timeout after 10s" },
            ),
          ],
        },
        {
          kind: "step",
          name: "3",
          status: "ok",
          start_ms: 20_620,
          duration_ms: 27_660,
          attrs: { context_tokens: 49_340, usage: { input_tokens: 49_340, output_tokens: 3430 }, llm_ms: 27_660, final: true },
        },
      ],
    },
    { kind: "result", status: "ok", start_ms: 48_298, attrs: { report_bytes: 9120, steps: 3, searches: 2, fetches: 3, read: 2, unread: 6, exhausted: false } },
  ],
});

/**
 * Plays a stored trace again as the gateway would have reported it: each
 * node as it began, then as it ended. `speed` shortens the wait.
 */
export function replay(nodes: TraceNode[], emit: (node: TraceNode) => void, speed = 1): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const node of nodes) {
    const took = node.duration_ms ?? 0;
    if (took === 0) {
      timers.push(setTimeout(() => emit(node), node.start_ms / speed));
      continue;
    }
    const { usage: _u, winner: _w, first_chunk_ms: _f, finish_reason: _r, bytes: _b, results: _n, ...begun } = (node.attrs ?? {}) as Record<string, unknown>;
    timers.push(setTimeout(() => emit({ ...node, status: "running", duration_ms: 0, http_status: undefined, error: undefined, attrs: begun }), node.start_ms / speed));
    timers.push(setTimeout(() => emit(node), (node.start_ms + took) / speed));
  }
  return () => timers.forEach(clearTimeout);
}
