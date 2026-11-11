// Searches a site through its OpenCLI adapter: X for now. The posts keep
// what an agent reads (who, when, what, how it was received, where); the
// avatars, bios and video posters OpenCLI also returns are left out.

import { json } from "./opencli.ts";
import { FetchError, type Post } from "./protocol.ts";

/** What this worker can search, as announced to the gateway in its hello. */
export const features = ["x_search"] as const;

export interface SearchOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  profile?: string;
}

export interface SearchRequest {
  site: string;
  query: string;
  /** "top" or "latest". */
  sort?: string;
  limit: number;
}

export async function search(req: SearchRequest, opts: SearchOptions): Promise<Post[]> {
  switch (req.site) {
    case "x":
      return searchX(req, opts);
  }
  throw new FetchError("internal", `this worker cannot search ${JSON.stringify(req.site)}`);
}

/** A row of `opencli twitter search`, and its quoted tweet. */
interface Tweet {
  id?: string;
  author?: string;
  name?: string;
  text?: string;
  created_at?: string;
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: string | number;
  url?: string;
  media_urls?: string[];
  quoted_tweet?: Tweet | null;
}

async function searchX(req: SearchRequest, opts: SearchOptions): Promise<Post[]> {
  const limit = Math.max(1, Math.min(Math.floor(req.limit) || 10, 100));
  // Every option comes before "--": a query such as "-filter:replies cats" would otherwise be read as OpenCLI's -f.
  const args = ["twitter", "search", "--product", req.sort === "latest" ? "live" : "top", "--limit", String(limit), "-f", "json", "--", req.query];
  let rows: unknown;
  try {
    rows = await json(args, opts, false);
  } catch (err) {
    // Nothing matched: an answer, not a failure.
    if (err instanceof FetchError && err.code === "empty") return [];
    throw err;
  }
  if (!Array.isArray(rows)) throw new FetchError("failed", "OpenCLI returned something other than a list of tweets");
  return (rows as Tweet[]).filter((t) => t?.id).slice(0, limit).map(post);
}

function post(t: Tweet): Post {
  const author = t.author ?? "";
  const quoted = t.quoted_tweet?.id ? post(t.quoted_tweet) : undefined;
  const media = (t.media_urls ?? []).filter(Boolean);
  const views = count(t.views);
  return {
    id: String(t.id),
    url: tweetURL(t),
    author,
    ...(t.name ? { name: t.name } : {}),
    text: t.text ?? "",
    ...(t.created_at ? { created_at: isoTime(t.created_at) } : {}),
    likes: count(t.likes),
    reposts: count(t.retweets),
    replies: count(t.replies),
    ...(views ? { views } : {}),
    ...(media.length ? { media } : {}),
    ...(quoted ? { quoted } : {}),
  };
}

/** The tweet's address under its author, which OpenCLI sometimes gives as /i/status. */
function tweetURL(t: Tweet): string {
  if (t.author && t.id && (!t.url || /\/i\/status\//.test(t.url))) return `https://x.com/${t.author}/status/${t.id}`;
  return t.url ?? `https://x.com/i/status/${t.id}`;
}

function count(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** X's "Wed Nov 11 17:45:23 +0000 2026" as RFC 3339; anything else as it came. */
export function isoTime(s: string): string {
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(s.trim());
  const month = m ? months.indexOf(m[1]) : -1;
  if (!m || month < 0) return s;
  const offset = (m[6] === "-" ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8]));
  const ms = Date.UTC(Number(m[9]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - offset * 60_000;
  return new Date(ms).toISOString().replace(".000Z", "Z");
}
