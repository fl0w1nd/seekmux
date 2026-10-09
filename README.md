# SeekMux

A self-hosted search, fetch and research gateway for AI agents.

SeekMux puts several search and page-reading services behind one MCP endpoint.
Your agent gets three tools; SeekMux decides which provider serves each call,
keeps every provider inside its rate limit, and moves on to the next one when
a provider is slow, failing or out of credits. Everything is configured in a
web console and applies without a restart.

It is one small Go binary with a single SQLite file, meant for a cheap server.

## What it does

| Tool | Providers | Behaviour |
| --- | --- | --- |
| `search` | Brave, Exa, Perplexity, Tavily | Tried in your priority order; a provider that is rate limited or failing is skipped. |
| `fetch` | Exa, Firecrawl, Jina Reader, Tavily | A slow provider is raced by the next one. Given a prompt, a model answers from the page instead of returning all of it. |
| `research` | any configured model | An agent searches and reads on its own and returns a sourced report. Also available as `research_start` / `research_result` for clients with short timeouts. |

Around the tools:

- **Rate limits and concurrency** per provider and per model, shared by
  everything that uses them.
- **Failover** between providers, and along a chain of models for extraction.
- **Circuit breaker**: something that keeps failing is skipped for a while.
  A rejected API key or exhausted credits switch a provider off until you
  re-enable it, and the console shows what the provider answered.
- **Models** from OpenAI-compatible and Anthropic endpoints, each with its own
  parameters, reasoning setting and limits.
- **Access keys** for agents, limited to specific tools and with their own
  rate limit.
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

1. **Providers** — paste the API keys of the services you use.
2. **Search / Fetch** — order the providers and adjust their limits.
3. **Models** (optional) — add a model endpoint to enable prompt-based
   extraction and research.
4. **Access keys** — create a key for your agent.

Images for `linux/amd64` and `linux/arm64` are published at
`ghcr.io/fl0w1nd/seekmux`. All state lives in the `./data` volume.

To skip the setup token, set `SEEKMUX_ADMIN_PASSWORD` (10+ characters) in a
`.env` file next to `docker-compose.yml` before the first start.

## Connect an agent

The MCP endpoint is `/mcp` (Streamable HTTP). Send the access key as a bearer
token:

```bash
claude mcp add --transport http seekmux https://your-host/mcp --header "Authorization: Bearer smx_..."
```

Any MCP client that supports Streamable HTTP and custom headers works the same
way; `X-API-Key: smx_...` is accepted as well.

## Deploying

Put a TLS-terminating reverse proxy in front of it. The compose file binds to
`127.0.0.1:8787` for a proxy on the same host. Two proxy settings matter:

- **No response buffering** for `/mcp` and `/api/logs/stream`; both stream.
- **A read timeout longer than your research time budget** (5 minutes by
  default), or have agents use `research_start` / `research_result`.

The proxy should send `X-Forwarded-For` and `X-Forwarded-Proto`, as most do by
default: the first keeps login throttling per client, the second marks the
session cookie as secure.

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

### Backup and moving

Everything is in the data directory. To move only the configuration:

```bash
seekmux export > seekmux.yaml     # contains your API keys in plain text
seekmux import seekmux.yaml
```

Lost the admin password? `seekmux reset-password` removes it, and the next
start prints a new setup token.

## Development

Requires Go 1.27+ and pnpm.

```bash
make dev      # backend on :8787, console with hot reload on :5173
make test     # go vet, go test, TypeScript check
make build    # console + bin/seekmux
```

The backend is in `internal/`, the console (React, TypeScript, Tailwind) in
`web/`; its design system is described in [web/DESIGN.md](web/DESIGN.md). The
console is embedded in the binary, so build it before `go build` if you want
it served.

Commits follow [Conventional Commits](https://www.conventionalcommits.org);
release notes are generated from them. Issues and pull requests are welcome.

## License

[MIT](LICENSE)
