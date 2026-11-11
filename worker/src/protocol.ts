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

/** A post a search found; internal/worker/protocol.go's Post. */
export interface Post {
  id: string;
  url: string;
  author: string;
  name?: string;
  text: string;
  /** RFC 3339, or as the site wrote it. */
  created_at?: string;
  likes: number;
  reposts: number;
  replies: number;
  views?: number;
  media?: string[];
  quoted?: Post;
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
  | "outdated"
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
  | { type: "search"; id: string; site: string; query: string; sort?: string; limit: number; profile?: string; timeout_ms: number }
  | { type: "cancel"; id: string };

export type WorkerMessage =
  | { type: "hello"; protocol: number; token: string; version: string; slots: number; features: readonly string[]; state: State }
  | { type: "state"; state: State }
  | { type: "result"; id: string; page?: Page; posts?: Post[]; error?: WireError };

/** A failed fetch or search, with the code the gateway acts on. */
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
