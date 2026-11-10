import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, APIError, type ActiveNode, type LiveCall, type LiveDone, type LogEntry, type NodeStatus, type TraceNode, type TraceText } from "./api";

/** The trace of a call as it stands: its nodes in the order they were made, and what its models have written. */
export interface TraceState {
  nodes: TraceNode[];
  text: TraceText;
}

const empty: TraceState = { nodes: [], text: {} };

/**
 * Holds the trace of a call that is still running. Nodes and text arrive far
 * faster than a screen is drawn, so readers are told at most once a frame.
 */
export class TraceStore {
  private nodes = new Map<number, TraceNode>();
  private text: TraceText = {};
  private state: TraceState = empty;
  private stale = false;
  private frame = 0;
  private listeners = new Set<() => void>();

  put(node: TraceNode) {
    this.nodes.set(node.id, node);
    this.touch();
  }

  append(node: number, delta: string) {
    this.text[node] = (this.text[node] ?? "") + delta;
    this.touch();
  }

  /** Replaces everything, as a snapshot of the call does. */
  reset(nodes: TraceNode[] = [], text: TraceText = {}) {
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
    this.text = { ...text };
    this.touch();
  }

  private touch() {
    this.stale = true;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      for (const listener of this.listeners) listener();
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): TraceState => {
    if (this.stale) {
      this.stale = false;
      this.state = { nodes: [...this.nodes.values()].sort((a, b) => a.id - b.id), text: { ...this.text } };
    }
    return this.state;
  };
}

export function useTraceStore(store: TraceStore): TraceState {
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

/* ---------- A call in flight ---------- */

export interface LiveTrace extends TraceState {
  call?: LiveCall;
  /** Set once the call has ended. */
  done?: LiveDone;
  /** The server no longer knows the call: it ended a while ago, or never was. */
  gone: boolean;
  /** The moment the call began, by this browser's clock. */
  origin: number;
}

/** Follows a call in flight by its id. */
export function useLiveCall(callId: string | undefined): LiveTrace {
  const store = useMemo(() => new TraceStore(), [callId]);
  const trace = useTraceStore(store);
  const [meta, setMeta] = useState<{ id?: string; call?: LiveCall; done?: LiveDone; gone: boolean; origin: number }>({ gone: false, origin: 0 });

  useEffect(() => {
    if (!callId) return;
    setMeta({ id: callId, gone: false, origin: 0 });
    const source = new EventSource(`/api/live/${encodeURIComponent(callId)}/stream`);
    let ended = false;
    const parse = <T,>(e: Event) => JSON.parse((e as MessageEvent<string>).data) as T;
    source.addEventListener("snapshot", (e) => {
      const data = parse<{ now: number; call: LiveCall; nodes: TraceNode[] | null; text: TraceText | null }>(e);
      store.reset(data.nodes ?? [], data.text ?? {});
      // The server's clock says when the call began; this one says how long ago that is.
      setMeta((m) => ({ ...m, call: data.call, origin: Date.now() - (data.now - data.call.started_at) }));
    });
    source.addEventListener("node", (e) => store.put(parse<TraceNode>(e)));
    source.addEventListener("text", (e) => {
      const { node, delta } = parse<{ node: number; delta: string }>(e);
      store.append(node, delta);
    });
    source.addEventListener("done", (e) => {
      ended = true;
      setMeta((m) => ({ ...m, done: parse<LiveDone>(e) }));
      source.close();
    });
    source.onerror = () => {
      // The browser reconnects by itself; an id the server does not know is refused for good.
      if (!ended && source.readyState === EventSource.CLOSED) setMeta((m) => ({ ...m, gone: true }));
    };
    return () => source.close();
  }, [callId, store]);

  return meta.id === callId ? { ...trace, call: meta.call, done: meta.done, gone: meta.gone, origin: meta.origin } : { ...empty, gone: false, origin: 0 };
}

/**
 * The calls in flight, kept current over the stream that also announces every
 * stored log entry. `onEntry` is told of each of those.
 */
export function useLiveCalls(enabled: boolean, onEntry?: (entry: LogEntry) => void): { calls: LiveCall[]; origin: (call: LiveCall) => number } {
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const skew = useRef(0);
  const entry = useRef(onEntry);
  entry.current = onEntry;

  useEffect(() => {
    if (!enabled) {
      setCalls([]);
      return;
    }
    const source = new EventSource("/api/logs/stream");
    const parse = <T,>(e: Event) => JSON.parse((e as MessageEvent<string>).data) as T;
    source.onmessage = (e) => entry.current?.(parse<LogEntry>(e));
    source.addEventListener("snapshot", (e) => {
      const data = parse<{ now: number; calls: LiveCall[] | null }>(e);
      skew.current = Date.now() - data.now;
      setCalls(data.calls ?? []);
    });
    source.addEventListener("call", (e) => {
      const call = parse<LiveCall>(e);
      setCalls((list) => (list.some((c) => c.call_id === call.call_id) ? list.map((c) => (c.call_id === call.call_id ? call : c)) : [...list, call]));
    });
    source.addEventListener("done", (e) => {
      const done = parse<LiveDone>(e);
      setCalls((list) => list.filter((c) => c.call_id !== done.call_id));
    });
    return () => source.close();
  }, [enabled]);

  return { calls, origin: (call) => call.started_at + skew.current };
}

/* ---------- A playground call ---------- */

export interface PlayState<V, R> {
  pending: boolean;
  /** What the call was made with. */
  variables?: V;
  data?: R;
  error?: Error;
  /** When the call was made, by this browser's clock; 0 before the first. */
  submittedAt: number;
  callId?: string;
}

/**
 * A playground call that can be watched while it runs: its trace fills the
 * store as the server reports it, and `stop` ends the call on the server too.
 */
export function usePlay<V, R>(fn: (body: V, events: { onCall: (id: string) => void; onNode: (n: TraceNode) => void; onText: (node: number, delta: string) => void }, signal: AbortSignal) => Promise<R>) {
  const store = useMemo(() => new TraceStore(), []);
  const trace = useTraceStore(store);
  const [state, setState] = useState<PlayState<V, R>>({ pending: false, submittedAt: 0 });
  const abort = useRef<AbortController | null>(null);
  const run = useRef(0);
  // The gateway's id of the call in flight, once it has said it.
  const flying = useRef("");
  useEffect(() => () => abort.current?.abort(), []);

  const start = (variables: V) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const id = ++run.current;
    const current = () => run.current === id;
    const began = Date.now();
    let call = "";
    flying.current = "";
    store.reset();
    setState({ pending: true, variables, submittedAt: began });
    fn(
      variables,
      {
        onCall: (callId) => {
          call = callId;
          if (!current()) return;
          flying.current = callId;
          setState((s) => ({ ...s, callId }));
        },
        onNode: (node) => current() && store.put(node),
        onText: (node, delta) => current() && store.append(node, delta),
      },
      controller.signal,
    ).then(
      (data) => {
        if (!current()) return;
        // The result carries the trace whole: a server that does not stream still shows it.
        const nodes = (data as { trace?: TraceNode[] } | undefined)?.trace;
        if (nodes?.length) store.reset(nodes, store.snapshot().text);
        setState((s) => ({ ...s, pending: false, data }));
      },
      (error: unknown) => {
        if (!current()) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        // The stream ended before the call's last nodes: nothing of it runs any more.
        const stopped = failure instanceof APIError && failure.status === 499;
        const elapsed = Date.now() - began;
        for (const node of store.snapshot().nodes) {
          if (node.status !== "running") continue;
          const root = node.id === 1;
          store.put({ ...node, status: root && !stopped ? "error" : "canceled", duration_ms: Math.max(0, elapsed - node.start_ms), error: root && !stopped ? failure.message : node.error });
        }
        setState((s) => ({ ...s, pending: false, error: failure }));
        if (call) void settle(call, current);
      },
    );
  };

  // What the gateway recorded of a call that was cut short is how it really ended; its entry is written a moment later.
  const settle = async (callId: string, current: () => boolean) => {
    for (let i = 0; i < 6 && current(); i++) {
      await new Promise((done) => setTimeout(done, 500));
      const entry = await api.logByCall(callId).catch(() => undefined);
      if (!entry) continue;
      if (current() && entry.trace?.length) store.reset(entry.trace, store.snapshot().text);
      return;
    }
  };

  // A call is stopped on the gateway, which records it as stopped and sends
  // its last nodes down the stream; closing the stream alone would leave it
  // recorded as a canceled request. The stream is closed here when the gateway
  // cannot be asked or does not end it soon.
  const stop = () => {
    const controller = abort.current;
    if (!controller || controller.signal.aborted) return;
    const id = flying.current;
    if (!id) return controller.abort();
    // The timer runs from the click: a cancel request that hangs must not keep the call going.
    const timer = setTimeout(() => controller.abort(), 3000);
    api.cancelCall(id).catch(() => {
      clearTimeout(timer);
      controller.abort();
    });
  };

  return {
    ...state,
    ...trace,
    start,
    stop,
    /** Whether the last call was stopped here rather than failing. */
    stopped: state.error instanceof APIError && state.error.status === 499,
  };
}

/* ---------- The tree ---------- */

export interface TreeNode extends TraceNode {
  children: TreeNode[];
}

/**
 * Repairs attempt trigger labels on traces where an earlier sibling attempt
 * under the same runner was rate-limited or skipped before the next provider ran.
 */
export function normalizeTrace(nodes: TraceNode[]): TraceNode[] {
  if (nodes.length === 0) return nodes;
  const priorByParent = new Map<number, { limited: boolean; failed: boolean }>();
  let changed = false;
  const out = nodes.map((node) => {
    if (node.kind !== "attempt" || !node.parent) return node;
    const state = priorByParent.get(node.parent) ?? { limited: false, failed: false };
    let next = node;
    if (attr<string>(node, "trigger") === "first") {
      const replacement = state.failed ? "after_failure" : state.limited ? "after_rate_limit" : undefined;
      if (replacement) {
        changed = true;
        next = { ...node, attrs: { ...node.attrs, trigger: replacement } };
      }
    }
    if (node.status === "limited") state.limited = true;
    else if (node.status === "skipped" || node.status === "error") state.failed = true;
    priorByParent.set(node.parent, state);
    return next;
  });
  return changed ? out : nodes;
}

/** The nodes as a tree. A node whose parent never arrived hangs from the root. */
export function buildTree(nodes: TraceNode[]): TreeNode | null {
  if (nodes.length === 0) return null;
  const normalized = normalizeTrace(nodes);
  const byId = new Map<number, TreeNode>(normalized.map((n) => [n.id, { ...n, children: [] }]));
  const root = byId.get(1) ?? byId.get(Math.min(...byId.keys()))!;
  for (const node of byId.values()) {
    if (node === root) continue;
    (byId.get(node.parent ?? 0) ?? root).children.push(node);
  }
  return root;
}

export const attr = <T,>(node: TraceNode | undefined, key: string): T | undefined => node?.attrs?.[key] as T | undefined;

export function findAll(node: TreeNode, test: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (test(node)) out.push(node);
  for (const child of node.children) findAll(child, test, out);
  return out;
}

/** What a call is doing at this moment: its running nodes that have nothing running inside them, oldest first. */
export function activeOf(nodes: TraceNode[]): ActiveNode[] {
  const busy = new Set<number>();
  for (const n of nodes) if (n.status === "running" && n.parent) busy.add(n.parent);
  return nodes.filter((n) => n.status === "running" && !busy.has(n.id)).slice(0, 4);
}

/** How long the node has taken: its duration, or the time since it began while it runs. */
export function elapsedOf(node: TraceNode, sinceStart: number): number {
  return node.status === "running" ? Math.max(0, sinceStart - node.start_ms) : (node.duration_ms ?? 0);
}

/* ---------- Entries from before traces ---------- */

/**
 * A trace for a log entry that has none: the call, its upstream attempts in
 * order and its outcome. It shows what was called, not why.
 */
export function legacyTrace(entry: LogEntry): TraceNode[] {
  const nodes: TraceNode[] = [
    {
      id: 1,
      kind: "call",
      name: entry.tool,
      status: entry.status === "ok" ? "ok" : "error",
      start_ms: 0,
      duration_ms: entry.duration_ms,
      error: entry.error,
      attrs: { source: entry.source, api_key_name: entry.api_key_name, client_ip: entry.client_ip, legacy: true },
    },
  ];
  for (const a of entry.attempts ?? []) {
    nodes.push({
      id: nodes.length + 1,
      parent: 1,
      kind: a.kind === "llm" ? "llm" : "attempt",
      name: a.provider,
      status: a.status as NodeStatus,
      start_ms: a.start_ms,
      duration_ms: a.duration_ms,
      http_status: a.http_status,
      error: a.error,
      attrs: { kind: a.kind, target: a.target },
    });
  }
  nodes.push({ id: nodes.length + 1, parent: 1, kind: "result", status: entry.status === "ok" ? "ok" : "error", start_ms: entry.duration_ms, error: entry.error });
  return nodes;
}
