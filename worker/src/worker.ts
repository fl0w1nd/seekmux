// The connection to the gateway: says hello, reports the browser's state,
// runs the fetches it is handed and reconnects when the connection drops.

import { Canceled, readState } from "./opencli.ts";
import { CloseCode, FetchError, PROTOCOL_VERSION, type ServerMessage, type State, type WorkerMessage } from "./protocol.ts";
import { read } from "./sites.ts";

export interface Options {
  /** The WebSocket URL of the gateway's /worker endpoint. */
  url: string;
  token: string;
  slots: number;
  version: string;
  log: (line: string) => void;
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
  for (;;) {
    const { code, reason, welcomed } = await session(opts, state, (next) => (state = next));
    if (code === CloseCode.Unauthorized || code === CloseCode.Protocol) {
      throw new Error(`the gateway refused this worker: ${reason || code}`);
    }
    if (code === CloseCode.Replaced) {
      throw new Error("another worker connected with the same token; this one stops so the two do not take turns");
    }
    if (welcomed) delay = 1000;
    opts.log(`disconnected (${reason || code}); reconnecting in ${delay / 1000}s`);
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
  welcomed: boolean;
}

function session(opts: Options, initial: State, setState: (s: State) => void): Promise<Ended> {
  return new Promise((resolve) => {
    let state = initial;
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
      send({ type: "hello", protocol: PROTOCOL_VERSION, token: opts.token, version: opts.version, slots: opts.slots, state });
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
          opts.log(`connected to ${opts.url} · ${opts.slots} slot${opts.slots > 1 ? "s" : ""}`);
          return;
        case "cancel":
          running.get(m.id)?.abort();
          return;
        case "fetch":
          break;
        default:
          return;
      }
      const { id, url } = m;
      if (running.size >= opts.slots) {
        send({ type: "result", id, error: { code: "busy", message: `the worker is already running ${running.size} fetches` } });
        return;
      }
      const controller = new AbortController();
      running.set(id, controller);
      const started = Date.now();
      opts.log(`→ ${url}${m.adapter ? " (adapter)" : ""}`);
      try {
        const page = await read(url, Boolean(m.adapter), { timeoutMs: m.timeout_ms, signal: controller.signal, profile: m.profile || undefined });
        send({ type: "result", id, page });
        opts.log(`✓ ${url} · ${page.source} · ${page.content.length} chars · ${seconds(started)}`);
      } catch (err) {
        if (err instanceof Canceled) {
          opts.log(`· ${url} · canceled by the gateway · ${seconds(started)}`);
          return;
        }
        const failure = err instanceof FetchError ? err : new FetchError("internal", err instanceof Error ? err.message : String(err));
        send({ type: "result", id, error: failure.toWire() });
        opts.log(`✗ ${url} · ${failure.code}: ${failure.message} · ${seconds(started)}`);
        if (failure.code === "browser_unavailable" || failure.code === "profile_missing") void check();
      } finally {
        running.delete(id);
      }
    });

    ws.addEventListener("close", (event) => {
      clearInterval(timer);
      for (const controller of running.values()) controller.abort();
      resolve({ code: event.code, reason: event.reason, welcomed });
    });
    // An error is followed by a close event, which ends the session.
    ws.addEventListener("error", () => {});
  });
}

function seconds(started: number): string {
  return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}
