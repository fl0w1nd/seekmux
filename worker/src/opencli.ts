// Runs OpenCLI as a child process and turns what it prints into pages,
// states and errors. OpenCLI is a dependency of this package, so the version
// it runs is the one this package was tested with.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FetchError, type ErrorCode, type Profile, type State } from "./protocol.ts";

const main = fileURLToPath(import.meta.resolve("@jackwener/opencli"));

/** The version of OpenCLI this worker runs. */
export const openCLIVersion: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.resolve("@jackwener/opencli")), "utf8"));
    return String(pkg.version);
  } catch {
    return "";
  }
})();

/** What OpenCLI prints on failure, and on success with -f json. */
interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; help?: string; exitCode?: number };
}

interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** The Chrome profile, by context id; empty leaves it to OpenCLI. */
  profile?: string;
  /**
   * A built-in command such as doctor or profile list: its failure is taken
   * as it is, without reading the profiles again (which would run itself).
   */
  builtin?: boolean;
}

interface Output {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Thrown when the caller canceled the fetch; nothing is reported for it. */
export class Canceled extends Error {}

function run(args: string[], opts: RunOptions): Promise<Output> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Canceled("canceled"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // OpenCLI gives up on a browser step after this many seconds.
      OPENCLI_BROWSER_COMMAND_TIMEOUT: String(Math.max(5, Math.floor(opts.timeoutMs / 1000))),
      // Close the tab a read opened, so tabs do not pile up in the user's Chrome.
      OPENCLI_CLOSE_OWNED_TAB: "1",
    };
    if (opts.profile) env.OPENCLI_PROFILE = opts.profile;
    const child = spawn(process.execPath, [main, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

    // A canceled read is left to finish: OpenCLI closes the tab it opened
    // and releases its hold on the site only when the command ends, and has
    // no signal handler to do it when killed. The slot stays taken until
    // then. Killing is kept for the deadline, after which OpenCLI reclaims
    // the hold by itself (within 45s).
    let ended: "timeout" | "canceled" | undefined;
    const timer = setTimeout(() => {
      ended ??= "timeout";
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, opts.timeoutMs);
    const onAbort = () => {
      ended ??= "canceled";
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new FetchError("internal", `could not start OpenCLI: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (ended === "canceled") return reject(new Canceled("canceled"));
      if (ended === "timeout") return reject(new FetchError("timeout", `OpenCLI did not finish within ${Math.round(opts.timeoutMs / 1000)}s`));
      resolve({ stdout, stderr, code });
    });
  });
}

/** Finds the JSON envelope OpenCLI printed, on either stream. */
function envelope(out: Output): Envelope | undefined {
  for (const text of [out.stdout, out.stderr]) {
    const start = text.indexOf("{");
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(start)) as Envelope;
      if (typeof parsed === "object" && parsed && "ok" in parsed) return parsed;
    } catch {
      // Not JSON, or not only JSON: try the other stream.
    }
  }
  return undefined;
}

/** Maps an OpenCLI failure to the code the gateway acts on. */
function failure(out: Output): FetchError {
  const env = envelope(out);
  const code = env?.error?.code ?? "";
  // OpenCLI also reports a bare HTTP 403 from the site as AUTH_REQUIRED,
  // guessing that a login is missing; a site's own blocking answers 403 to
  // a signed-in profile just as well.
  if (code === "AUTH_REQUIRED" && /\bHTTP 403\b/.test(env?.error?.message ?? "")) {
    return new FetchError("blocked", `the site refused the request with HTTP 403, which does not show that the browser profile is signed out: ${env?.error?.message}`, 403);
  }
  const message = [env?.error?.message, env?.error?.help].filter(Boolean).join(" — ") || lastLine(out.stderr) || `OpenCLI exited with ${out.code}`;
  const map: Record<string, ErrorCode> = {
    AUTH_REQUIRED: "login_required",
    // An HTML page where JSON was expected: a login wall, a rate limit or a
    // WAF challenge, OpenCLI cannot tell which. The message says as much.
    LOGIN_WALL: "blocked",
    // The site's own security filter, or its rate limit.
    SECURITY_BLOCK: "blocked",
    RATE_LIMITED: "blocked",
    EMPTY_RESULT: "empty",
    TIMEOUT: "timeout",
    SESSION_BUSY: "busy",
    BROWSER_CONNECT: "browser_unavailable",
  };
  return new FetchError(map[code] ?? "failed", message);
}

/**
 * Says what is wrong with the profile choice, by OpenCLI's own rule: a
 * chosen profile must be connected; without one, the default is used, else
 * the only connected profile. It mirrors State.Route on the gateway.
 */
export function profileProblem(profiles: Profile[], chosen?: string): FetchError | undefined {
  const connected = profiles.filter((p) => p.connected);
  if (chosen) {
    if (!profiles.some((p) => p.id === chosen)) return new FetchError("profile_missing", `OpenCLI on the worker does not know the Chrome profile "${chosen}"`);
    if (!connected.some((p) => p.id === chosen)) return new FetchError("browser_unavailable", `the Chrome profile "${chosen}" is not open on the worker`);
    return undefined;
  }
  if (connected.length > 1 && !connected.some((p) => p.default)) {
    return new FetchError("profile_missing", `${connected.length} Chrome profiles are connected and none is chosen: choose one for OpenCLI in the console`);
  }
  if (connected.length === 0) return new FetchError("browser_unavailable", "no Chrome profile is connected to OpenCLI on the worker");
  return undefined;
}

/**
 * Turns a failed run into its error. When OpenCLI could not reach the
 * browser, the profiles are read again and judged by profileProblem, rather
 * than by the wording of OpenCLI's message.
 */
async function failed(out: Output, opts: RunOptions): Promise<FetchError> {
  const err = failure(out);
  if (err.code !== "browser_unavailable" || opts.builtin) return err;
  const profiles = await listProfiles().catch(() => undefined);
  return (profiles && profileProblem(profiles, opts.profile)) ?? err;
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

/**
 * Runs an OpenCLI command and returns the data of the JSON it prints. Site
 * commands are asked for JSON; built-in ones such as doctor print only JSON
 * and refuse the flag, and a command whose arguments end in "--" places the
 * flag itself (format: false).
 */
export async function json(args: string[], opts: RunOptions, format = true): Promise<unknown> {
  const out = await run(format ? [...args, "-f", "json"] : args, opts);
  const env = envelope(out);
  if (out.code !== 0 || !env?.ok) throw await failed(out, opts);
  return env.data;
}

/** Runs an OpenCLI command that prints its result as it is. */
export async function text(args: string[], opts: RunOptions): Promise<string> {
  const out = await run(args, opts);
  if (out.code !== 0) throw await failed(out, opts);
  return out.stdout;
}

interface Doctor {
  extensionConnected?: boolean;
  connectivity?: { ok?: boolean; error?: string };
  issues?: string[];
}

interface ProfileList {
  profiles?: { contextId: string; alias?: string; default?: boolean; connected?: boolean }[];
}

/** The Chrome profiles OpenCLI knows: connected ones, and those it has an alias or default for. */
async function listProfiles(): Promise<Profile[]> {
  const list = (await json(["profile", "list"], { timeoutMs: 30_000, builtin: true }, false)) as ProfileList;
  return (list.profiles ?? []).map((p) => ({
    id: p.contextId,
    ...(p.alias ? { alias: p.alias } : {}),
    ...(p.default ? { default: true } : {}),
    connected: Boolean(p.connected),
  }));
}

/**
 * Asks OpenCLI whether it reaches a browser, and which profiles it knows.
 *
 * The worker is ready while a Chrome profile is connected. Which profile a
 * read uses is the gateway's choice, sent with each fetch, so readiness does
 * not follow doctor's verdict: doctor judges by OpenCLI's local default and
 * reports several connected profiles without one as not connected.
 */
export async function readState(): Promise<State> {
  let doctorProblem: string | undefined;
  try {
    // doctor starts the daemon when it is not running.
    const doctor = (await json(["doctor"], { timeoutMs: 30_000, builtin: true }, false)) as Doctor;
    if (!doctor.extensionConnected || !doctor.connectivity?.ok) {
      doctorProblem = doctor.connectivity?.error ?? doctor.issues?.[0]?.split("\n")[0];
    }
  } catch (err) {
    doctorProblem = err instanceof Error ? err.message : String(err);
  }
  let profiles: Profile[] = [];
  let listProblem: string | undefined;
  try {
    profiles = await listProfiles();
  } catch (err) {
    listProblem = err instanceof Error ? err.message : String(err);
  }
  const ready = profiles.some((p) => p.connected);
  const problem = ready ? undefined : (doctorProblem ?? listProblem ?? "no Chrome profile is connected to OpenCLI");
  return { ready, ...(problem ? { problem } : {}), opencli: openCLIVersion, profiles };
}
