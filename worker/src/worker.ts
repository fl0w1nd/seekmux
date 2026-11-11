// The connection to the gateway: says hello, reports the browser's state,
// runs the fetches and searches it is handed and reconnects when the
// connection drops.

import { diagnose } from "./diagnose.ts";
import { Canceled, readState } from "./opencli.ts";
import { CloseCode, FetchError, PROTOCOL_VERSION, type ServerMessage, type State, type WorkerMessage } from "./protocol.ts";
import { features, search } from "./search.ts";
import { read } from "./sites.ts";

export interface Options {
  /** The WebSocket URL of the gateway's /worker endpoint. */
  url: string;
  token: string;
  slots: number;
  version: string;
  log: (line: string) => void;
  /** Called each time the gateway accepts the worker. */
  onWelcome?: () => void;
}

/** How often the browser's state is checked and sent, which also keeps the connection in use. */
const STATE_INTERVAL = 30_000;

/** Turns what the user typed into the URL of the gateway's worker endpoint. */
export function endpoint(server: string): string {
  const url = new URL(/^[a-z]+:\/\//i.test(server) ? server : `https://${server}`);
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/worker";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Runs until the gateway refuses the worker for good. */
export async function run(opts: Options): Promise<never> {
  let state = await readState();
  logState(opts, state);
  let delay = 1000;
  // Why the last connection could not be opened, said again only when it changes.
  let problem: string | undefined;
  for (;;) {
    const { code, reason, opened, welcomed } = await session(opts, state, (next) => (state = next));
    if (code === CloseCode.Unauthorized || code === CloseCode.Protocol) {
      throw new Error(`the gateway refused this worker: ${reason || code}`);
    }
    if (code === CloseCode.Replaced) {
      throw new Error("another worker connected with the same token; this one stops so the two do not take turns");
    }
    if (welcomed) delay = 1000;
    if (opened) {
      problem = undefined;
      opts.log(`disconnected (${reason || code}); reconnecting in ${delay / 1000}s`);
    } else {
      const why = await diagnose(opts.url);
      opts.log(why && why === problem ? `could not connect, as before; retrying in ${delay / 1000}s` : `could not connect to ${opts.url}${why ? `: ${why}` : ""}; retrying in ${delay / 1000}s`);
      problem = why;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}

function logState(opts: Options, state: State) {
  const profiles = state.profiles.map((p) => `${p.alias ?? p.id}${p.connected ? "" : " (closed)"}`).join(", ") || "none";
  opts.log(state.ready ? `browser ready · OpenCLI ${state.opencli} · profiles: ${profiles}` : `browser not ready: ${state.problem}`);
}

interface Ended {
  code: number;
  reason: string;
  /** Whether the WebSocket handshake succeeded. */
  opened: boolean;
  welcomed: boolean;
}

function session(opts: Options, initial: State, setState: (s: State) => void): Promise<Ended> {
  return new Promise((resolve) => {
    let state = initial;
    let opened = false;
    let welcomed = false;
    const running = new Map<string, AbortController>();
    const ws = new WebSocket(opts.url);
    const send = (m: WorkerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };

    // Re-read the state now and then, and right after a fetch found the
    // browser unreachable; send it when it changed.
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const next = await readState();
        const changed = JSON.stringify(next) !== JSON.stringify(state);
        state = next;
        setState(next);
        if (changed) logState(opts, next);
        // Sent even unchanged: it keeps the connection in use.
        send({ type: "state", state: next });
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(check, STATE_INTERVAL);

    ws.addEventListener("open", () => {
      opened = true;
      send({ type: "hello", protocol: PROTOCOL_VERSION, token: opts.token, version: opts.version, slots: opts.slots, features, state });
    });

    ws.addEventListener("message", async (event) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (m.type) {
        case "welcome":
          welcomed = true;
          opts.onWelcome?.();
          opts.log(`connected to ${opts.url} · ${opts.slots} slot${opts.slots > 1 ? "s" : ""}`);
          return;
        case "cancel":
          running.get(m.id)?.abort();
          return;
        case "fetch":
        case "search":
          break;
        default:
          return;
      }
      const { id } = m;
      // What the log calls the request.
      const label = m.type === "fetch" ? m.url : `search ${m.site}: ${m.query}`;
      if (running.size >= opts.slots) {
        send({ type: "result", id, error: { code: "busy", message: `the worker is already running ${running.size} requests` } });
        return;
      }
      const controller = new AbortController();
      running.set(id, controller);
      const started = Date.now();
      const run = { timeoutMs: m.timeout_ms, signal: controller.signal, profile: m.profile || undefined };
      opts.log(`→ ${label}${m.type === "fetch" && m.adapter ? " (adapter)" : ""}`);
      try {
        if (m.type === "fetch") {
          const page = await read(m.url, Boolean(m.adapter), run);
          send({ type: "result", id, page });
          opts.log(`✓ ${label} · ${page.source} · ${page.content.length} chars · ${seconds(started)}`);
        } else {
          const posts = await search({ site: m.site, query: m.query, sort: m.sort, limit: m.limit }, run);
          send({ type: "result", id, posts });
          opts.log(`✓ ${label} · ${posts.length} posts · ${seconds(started)}`);
        }
      } catch (err) {
        if (err instanceof Canceled) {
          opts.log(`· ${label} · canceled by the gateway · ${seconds(started)}`);
          return;
        }
        const failure = err instanceof FetchError ? err : new FetchError("internal", err instanceof Error ? err.message : String(err));
        send({ type: "result", id, error: failure.toWire() });
        opts.log(`✗ ${label} · ${failure.code}: ${failure.message} · ${seconds(started)}`);
        if (failure.code === "browser_unavailable" || failure.code === "profile_missing") void check();
      } finally {
        running.delete(id);
      }
    });

    ws.addEventListener("close", (event) => {
      clearInterval(timer);
      for (const controller of running.values()) controller.abort();
      resolve({ code: event.code, reason: event.reason, opened, welcomed });
    });
    // An error is followed by a close event, which ends the session.
    ws.addEventListener("error", () => {});
  });
}

function seconds(started: number): string {
  return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}
