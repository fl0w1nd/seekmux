// The frames exchanged with the gateway. internal/worker/protocol.go is the
// other side and describes the exchange; change both together.

export const PROTOCOL_VERSION = 1;

/** Close codes the gateway ends a connection with. */
export const CloseCode = {
  Protocol: 4400,
  Unauthorized: 4401,
  Replaced: 4409,
} as const;

export interface Profile {
  /** The OpenCLI context id of the Chrome profile. */
  id: string;
  alias?: string;
  default?: boolean;
  connected: boolean;
}

export interface State {
  /** OpenCLI reaches a browser through its extension. */
  ready: boolean;
  problem?: string;
  opencli?: string;
  profiles: Profile[];
}

export interface Page {
  url: string;
  title?: string;
  content: string;
  /** What read it: an adapter ("twitter", "reddit") or "page". */
  source: string;
}

export type ErrorCode =
  // About the page: the gateway moves on to its next provider.
  | "login_required"
  | "not_found"
  | "blocked"
  | "empty"
  | "timeout"
  | "failed"
  // About the worker.
  | "profile_missing"
  | "browser_unavailable"
  | "busy"
  | "internal";

export interface WireError {
  code: ErrorCode;
  message: string;
  /** The site's HTTP status, when known. */
  status?: number;
}

export type ServerMessage =
  | { type: "welcome" }
  | { type: "fetch"; id: string; url: string; adapter?: boolean; profile?: string; timeout_ms: number }
  | { type: "cancel"; id: string };

export type WorkerMessage =
  | { type: "hello"; protocol: number; token: string; version: string; slots: number; state: State }
  | { type: "state"; state: State }
  | { type: "result"; id: string; page?: Page; error?: WireError };

/** A failed fetch, with the code the gateway acts on. */
export class FetchError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;

  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }

  toWire(): WireError {
    return { code: this.code, message: this.message, ...(this.status ? { status: this.status } : {}) };
  }
}
