// Reads a page: through a site's OpenCLI adapter when the gateway asked for
// one and the URL is a post the adapter reads, otherwise as the page renders.
//
// Rendering stays close to what OpenCLI returns. It only arranges the rows
// into Markdown an agent reads in order; it does not try to clean the text,
// which would risk dropping what the page says.

import { json, text } from "./opencli.ts";
import { FetchError, type Page } from "./protocol.ts";

interface ReadOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  profile?: string;
}

/** A URL a site adapter reads. */
type Match = { site: "twitter"; id: string } | { site: "reddit"; target: string };

/** The adapters this worker has, by the gateway's routing rule ids. */
export const adapters = ["twitter", "reddit"] as const;

export function match(raw: string): Match | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|mobile|m)\./, "");
  const path = url.pathname;
  if (host === "x.com" || host === "twitter.com") {
    const id = /^\/(?:[^/]+|i\/web|i)\/status(?:es)?\/(\d+)/.exec(path)?.[1];
    return id ? { site: "twitter", id } : undefined;
  }
  if (host === "redd.it") {
    const id = /^\/([a-z0-9]+)\/?$/i.exec(path)?.[1];
    return id ? { site: "reddit", target: id } : undefined;
  }
  if (host === "reddit.com" || host.endsWith(".reddit.com")) {
    return /\/comments\/[a-z0-9]+/i.test(path) ? { site: "reddit", target: url.origin + path } : undefined;
  }
  return undefined;
}

export async function read(url: string, adapter: boolean, opts: ReadOptions): Promise<Page> {
  const site = adapter ? match(url) : undefined;
  switch (site?.site) {
    case "twitter":
      return readTweet(url, site.id, opts);
    case "reddit":
      return readReddit(url, site.target, opts);
  }
  return readPage(url, opts);
}

async function readPage(url: string, opts: ReadOptions): Promise<Page> {
  const markdown = await text(["web", "read", "--url", url, "--stdout", "true", "--download-images", "false"], opts);
  if (!markdown.trim()) throw new FetchError("empty", "the page rendered without any text");
  const title = /^# (.+)$/m.exec(markdown)?.[1]?.trim();
  return { url, ...(title && title !== "untitled" ? { title } : {}), content: markdown, source: "page" };
}

interface Tweet {
  id: string;
  author: string;
  name?: string;
  text: string;
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: string | number;
  in_reply_to?: string;
  created_at?: string;
  url?: string;
  media_urls?: string[];
  quoted_tweet?: Tweet | null;
}

async function readTweet(url: string, id: string, opts: ReadOptions): Promise<Page> {
  const rows = (await json(["twitter", "thread", id, "--limit", "100"], opts)) as Tweet[];
  if (!Array.isArray(rows) || rows.length === 0) throw new FetchError("empty", "the thread came back empty");
  const main = rows.find((t) => t.id === id) ?? rows[0];
  // Replies in the order they were written, so a thread split into several
  // posts reads from its start.
  const replies = rows.filter((t) => t !== main).sort((a, b) => time(a) - time(b));
  const authors = new Map(rows.map((t) => [t.id, t.author]));

  const out = [`# @${main.author} on X`, "", tweetMeta(main), "", unescape(main.text)];
  if (main.media_urls?.length) out.push("", ...main.media_urls.map((u) => `![](${u})`));
  if (main.quoted_tweet) {
    const q = main.quoted_tweet;
    out.push("", `> Quoting @${q.author}${q.name ? ` (${q.name})` : ""}${q.url ? ` — ${q.url}` : ""}`, ">");
    out.push(...unescape(q.text).split("\n").map((line) => `> ${line}`));
  }
  if (replies.length) {
    out.push("", `## Replies (${replies.length})`);
    for (const r of replies) {
      const to = r.in_reply_to && r.in_reply_to !== main.id && authors.has(r.in_reply_to) ? ` · replying to @${authors.get(r.in_reply_to)}` : "";
      out.push("", `**@${r.author}**${to} · ${tweetMeta(r, true)}`, "", unescape(r.text));
      if (r.media_urls?.length) out.push(...r.media_urls.map((u) => `![](${u})`));
    }
  }
  const first = unescape(main.text).split("\n")[0].slice(0, 80);
  return { url: main.url ?? url, title: `@${main.author} on X: ${first}`, content: out.join("\n") + "\n", source: "twitter" };
}

function time(t: Tweet): number {
  const ms = t.created_at ? Date.parse(t.created_at) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function tweetMeta(t: Tweet, short = false): string {
  const parts: string[] = [];
  if (!short && t.name) parts.push(t.name);
  const ms = time(t);
  if (ms) parts.push(new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC");
  if (t.likes) parts.push(`${t.likes} likes`);
  if (!short && t.retweets) parts.push(`${t.retweets} reposts`);
  if (!short && t.views) parts.push(`${t.views} views`);
  if (!short && t.url) parts.push(t.url);
  return parts.join(" · ");
}

/** X sends post text HTML-escaped. */
function unescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

interface RedditRow {
  /** POST, L0, L1, …, or "" for a note such as "[+27 more top-level comments]". */
  type: string;
  author: string;
  score: number | string;
  text: string;
  url_overridden_by_dest?: string;
  gallery_urls?: string[];
  preview_image_url?: string;
}

async function readReddit(url: string, target: string, opts: ReadOptions): Promise<Page> {
  const args = ["reddit", "read", target, "--limit", "50", "--depth", "4", "--replies", "10", "--expand-more", "true"];
  const rows = (await json(args, opts)) as RedditRow[];
  const post = Array.isArray(rows) ? rows.find((r) => r.type === "POST") : undefined;
  if (!post) throw new FetchError("empty", "the post came back empty");

  // The post's text is its title, a blank line, and its body.
  const [title, ...body] = post.text.split("\n");
  const out = [`# ${title}`, "", `u/${post.author} · ${post.score} points`];
  const link = post.url_overridden_by_dest;
  if (link && link !== url) out.push("", `Link: ${link}`);
  const bodyText = body.join("\n").trim();
  if (bodyText) out.push("", bodyText);
  for (const image of [post.preview_image_url, ...(post.gallery_urls ?? [])]) if (image) out.push("", `![](${image})`);

  const comments = rows.filter((r) => r !== post);
  if (comments.length) out.push("", "## Comments", "");
  for (const row of comments) {
    const level = /^L(\d+)$/.exec(row.type) ? Number(row.type.slice(1)) : 0;
    const indent = "  ".repeat(level);
    // OpenCLI indents a reply and quotes it with "> " for a table; the list
    // nesting says the same, so the prefix comes off and the text stays.
    const prefix = "  ".repeat(level) + (level > 0 ? "> " : "");
    const lines = row.text.split("\n").map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line.trimStart().replace(/^> ?/, "")));
    if (!row.author) {
      out.push(`${indent}- *${lines.join(" ").trim()}*`);
      continue;
    }
    out.push(`${indent}- **u/${row.author}** (${row.score} points)`);
    for (const line of lines) out.push(line ? `${indent}  ${line}` : "");
  }
  return { url, title, content: out.join("\n") + "\n", source: "reddit" };
}
