# SeekMux

A self-hosted search, fetch and research gateway for AI agents.

SeekMux puts several search and page-reading services behind one MCP endpoint.
Your agent gets four tools; SeekMux decides which provider serves each call,
keeps every provider inside its rate limit, and moves on to the next one when
a provider is slow, failing or out of credits. Everything is configured in a
web console and applies without a restart.

It is one small Go binary with a single SQLite file, meant for a cheap server.

## What it does

| Tool | Providers | Behaviour |
| --- | --- | --- |
| `search` | AnySearch, Brave, Exa, Firecrawl, Parallel, Perplexity, Tavily | Tried in your priority order; a provider that is rate limited or failing is skipped. |
| `dev_search` | Firecrawl | Searches issues, merged pull requests, READMEs and documentation sites instead of the web, and returns the passages that matched. |
| `fetch` | AnySearch, Exa, Firecrawl, Jina Reader, Parallel, Tavily, and self-hosted fetchers | A slow provider is raced by the next one. Given a prompt, a model answers from the page instead of returning all of it. |
| `x_search` | self-hosted fetchers | Searches posts on X through OpenCLI in a Chrome signed in to X, with X's own search operators. |
| `research` | any configured model | An agent searches and reads on its own and returns a sourced report.¹ |

¹ Also as `research_start` / `research_result` / `research_cancel`, for agents
with other work to do meanwhile and for clients with short timeouts.

Around the tools:

- **Rate limits and concurrency** per provider and per model, shared by
  everything that uses them.
- **Failover** between providers, and along a chain of models for extraction.
- **Service routing**: rules send matching URLs to the providers you choose,
  in your order. Built-in URL patterns cover YouTube, X (Twitter), LinkedIn,
  Reddit, Instagram, Threads, Facebook, TikTok and arXiv; choose providers
  before switching a rule on. Statistics per domain show where each provider
  is turned away, which is where the next rule belongs.
- **Self-hosted fetchers**: pages that need a login, such as X or Reddit
  posts, read in your own signed-in Chrome on machines you run (see below).
- **Circuit breaker**: something that keeps failing is skipped for a while.
  A rejected API key or exhausted credits switch a provider off until you
  re-enable it, and the console shows what the provider answered.
- **Models** from OpenAI-compatible and Anthropic endpoints, each with its own
  parameters, reasoning setting and limits.
- **Access keys** for agents, limited to specific tools, with their own rate
  limit, models, research ceilings and expiry, and their usage counted per day.
- **Request logs** with the full upstream call chain of every request, live.
- **Playground** to try each tool from the browser.

## Quick start

```bash
curl -O https://raw.githubusercontent.com/fl0w1nd/seekmux/main/docker-compose.yml
docker compose up -d
docker compose logs seekmux
```

The log prints a one-time setup token. Open `http://127.0.0.1:8787`, use the
token to set the admin password, then:

The console is in Chinese; its pages are named below with their English
meaning.

1. **提供商** (Providers) — paste the API keys of the services you use and
   set their rate limits.
2. **工具** (Tools) — order the providers of each tool.
3. **模型接口** (Models, optional) — add a model endpoint to enable
   prompt-based extraction and research.
4. **访问密钥** (Access keys) — create a key for your agent, or let it sign
   in (below).
5. **新建抓取器** (New fetcher, on 提供商, optional) — read logged-in pages
   through your own Chrome (below).

Images for `linux/amd64` and `linux/arm64` are published at
`ghcr.io/fl0w1nd/seekmux`. All state lives in the `./data` volume.

To skip the setup token, set `SEEKMUX_ADMIN_PASSWORD` (10+ characters) in a
`.env` file next to `docker-compose.yml` before the first start.

## Connect an agent

The MCP endpoint is `/mcp` (Streamable HTTP). A client that supports MCP
authorization needs nothing but the address:

```bash
claude mcp add --transport http seekmux https://your-host/mcp
```

On its first connection the client opens the console in your browser; sign in
with the admin password, choose the tools it may call, and approve. It then
shows up under **访问密钥** as a key of its own, where you can limit or
revoke it. This works for clients that register themselves (OAuth 2.1 with
PKCE and dynamic client registration); it can be switched off under **系统** (System).

Or create an access key and send it as a bearer token:

```bash
claude mcp add --transport http seekmux https://your-host/mcp --header "Authorization: Bearer smx_..."
```

Any MCP client that supports Streamable HTTP and custom headers works that
way; `X-API-Key: smx_...` is accepted as well.

Behind a reverse proxy, set the public address under **系统 → 对外地址** when the proxy
does not pass `X-Forwarded-Proto`: the sign-in endpoints a client is told about
start with it.

## Self-hosted fetchers

Some pages give a crawler nothing but a login wall. A self-hosted fetcher reads
them in a Chrome where you are signed in, on a machine of yours, through
[OpenCLI](https://github.com/jackwener/opencli). For X and Reddit posts it uses
OpenCLI's site adapters, which return the post as data; other pages are read as
they render.

1. On **提供商** (Providers), choose **新建抓取器** (New fetcher). It comes
   with one worker and its token.
2. On the machine with Chrome, install the OpenCLI Browser Bridge extension
   ([Chrome Web Store](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk),
   or unpacked from [OpenCLI's releases](https://github.com/jackwener/opencli/releases))
   in the Chrome profile to read with, and run the worker (Node.js 22.4 or later):

   ```bash
   npx seekmux --server https://your-host --token <worker token>
   ```

   The console's **安装指南** (setup guide) on the fetcher shows the command
   with the token filled in and checks each step as the worker reports in.
   The worker connects to the gateway on its own, so the machine needs no
   open port.
3. Once the worker is online, choose the Chrome profile it reads with. This
   is needed when several profiles are connected and none is OpenCLI's
   default; otherwise OpenCLI picks one.
4. Switch the fetcher on under **工具 → 网页抓取** (Tools → Fetch), where it is
   listed with the other providers, or choose it in a routing rule, such as the built-in X
   (Twitter) rule, to send it only those pages.

A fetcher can have several workers, on one machine with different Chrome
profiles or on several machines; to the routes it is still one provider. A
page goes to the first worker that can take it. A page that cannot be read
(not signed in, not found, blocked) is not retried on another worker; the
fetch moves on to the next provider.

### Searching X

`x_search` runs X's own search in a worker's Chrome. Under **工具 → 社交媒体**
(Tools → Social media), add X, choose the OpenCLI fetcher and the workers
that search it; their Chrome profiles must be signed in to X. Workers are
tried in the fetcher's order, the next only when one cannot take the search
(offline, busy, browser unavailable). Searches share the fetcher's rate limit
and concurrency with the pages it reads. A worker older than 0.0.4 cannot
search and cannot be chosen; update it with `npx seekmux@latest`.

## Deploying

Put a TLS-terminating reverse proxy in front of it. The compose file binds to
`127.0.0.1:8787` for a proxy on the same host. Two proxy settings matter:

- **No response buffering** for `/mcp` and `/api/logs/stream`; both stream.
- **WebSocket upgrades** on `/worker`, if you run self-hosted fetchers. Their
  workers connect there. With nginx or OpenResty:

  ```nginx
  location /worker {
      proxy_pass http://127.0.0.1:8787;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```

  Without it the worker says the request "reached the gateway without its
  WebSocket upgrade".
- **A read timeout longer than your research time budget** (5 minutes by
  default), or have agents use `research_start` / `research_result`. One
  `research_result` call waits up to 50 seconds by default; raise it in the
  console as far as your client's tool timeout allows, so agents call less often.
- **Forwarding headers**: `X-Forwarded-For` keeps login throttling per
  client, `X-Forwarded-Proto` marks the session cookie as secure, and `Host`
  is the address research report links start with. If agents reach the
  gateway at an internal address, set the public one under **系统 → 对外地址**.

Every research report has a page, `/report/<task id>`, that anyone with the
link can read without signing in. The task id is long and random, and the
page is removed with the task after the log retention (14 days by default).

### Without Docker

Download or build the binary and run it under your service manager:

```bash
seekmux serve --addr 127.0.0.1:8787 --data /var/lib/seekmux
```

| Flag | Environment | Default |
| --- | --- | --- |
| `--addr` | `SEEKMUX_ADDR` | `:8787` |
| `--data` | `SEEKMUX_DATA_DIR` | `./data` |
| | `SEEKMUX_ADMIN_PASSWORD` | unset; when set it is applied on every start |
| | `SEEKMUX_ENCRYPTION_KEY` | unset; the key is then kept in `encryption.key` in the data directory |

### Backup and moving

Everything is in the data directory. The configuration, provider keys
included, is encrypted in the database with the key in `encryption.key`, which
is created on first start: back the two up together, and the database alone
gives no keys away. Set `SEEKMUX_ENCRYPTION_KEY` to a long random value to
keep the key out of the data directory instead; without the key the
configuration cannot be read and has to be entered again.

To move only the configuration:

```bash
seekmux export > seekmux.yaml     # contains your API keys in plain text
seekmux import seekmux.yaml
```

Lost the admin password? `seekmux reset-password` removes it, and the next
start prints a new setup token.

## Development

Tools come from [mise](https://mise.jdx.dev): `mise install` sets up Go,
Node.js and pnpm at the versions in `mise.toml` and `mise.lock`.

```bash
mise run dev      # local backend on :8787, console with hot reload on :5173
mise run test     # go vet, go test, TypeScript check
mise run lint     # what CI checks: gofmt, go mod tidy, go vet, types, workflows
mise run build    # console + bin/seekmux
mise tasks        # everything else
```

The worker package (`npx seekmux`) is in `worker/`. Create a fetcher in the
development console, then run a worker from source against it:

```bash
SEEKMUX_WORKER_TOKEN=<worker token> mise run dev:worker
```

`mise run dev` uses `1234567890` as the admin password and binds the backend to
`127.0.0.1`. Use `mise run dev:server` and `mise run dev:web` to run them in
separate terminals. The development password replaces the stored admin password on start.

The backend is in `internal/`, the console (React, TypeScript, Tailwind) in
`web/`, the worker (Node.js, TypeScript) in `worker/`. The console's design
system is described in [web/DESIGN.md](web/DESIGN.md). The console is
embedded in the binary, so build it before `go build` if you want it served.

Commits follow [Conventional Commits](https://www.conventionalcommits.org);
release notes are generated from them. Issues and pull requests are welcome.

## License

[MIT](LICENSE)
