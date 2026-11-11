// Remembers the gateway and the token the worker last connected with, so
// that it starts again with a bare `npx seekmux`. They are written only once
// the gateway accepted them, readable by the user alone, as gh and npm keep
// their tokens.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Saved {
  server: string;
  token: string;
}

/** Where the file lives: SEEKMUX_CONFIG_DIR, else the platform's configuration directory. */
export function savedPath(): string {
  const env = process.env;
  const dir =
    env.SEEKMUX_CONFIG_DIR ||
    (process.platform === "win32"
      ? join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "seekmux")
      : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "seekmux"));
  return join(dir, "worker.json");
}

export function loadSaved(path = savedPath()): Saved | undefined {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data?.server === "string" && typeof data?.token === "string" && data.server && data.token) {
      return { server: data.server, token: data.token };
    }
  } catch {
    // Missing or unreadable: nothing saved.
  }
  return undefined;
}

export function save(saved: Saved, path = savedPath()): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync keeps the mode of a file that already exists.
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/** Removes the saved file; false when there was none. Any other failure is thrown, so the token is not reported gone while it stays. */
export function forget(path = savedPath()): boolean {
  try {
    rmSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
