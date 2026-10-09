# SeekMux

A search / fetch / research gateway for AI agents. One small Go binary that
speaks MCP over Streamable HTTP, routes every call across several providers
with rate limiting and failover, and ships a web console to configure and
observe it.

- **search** — Exa, Brave, Tavily. Tried in priority order; a provider that is
  rate limited or failing is skipped.
- **fetch** — Firecrawl, Jina Reader, Tavily. A slow provider is raced by the
  next one. With a prompt, an extraction model answers from the page instead
  of returning all of it.
- **Models** — each model is defined once under its endpoint, with its own
  parameters, rate limit and concurrency. Extraction takes an ordered chain of
  models and fails over along it; research runs on a single model.
- **Circuit breaker** — a provider or extract model that keeps failing is
  skipped for a while, so calls go straight to the next one. One global policy,
  set on the System page.
- **research** — hands a whole question to an agent that searches and reads on
  its own and returns a sourced report. Off until you pick a model.
- **Console** — providers, routes and limits, model endpoints
  (OpenAI-compatible and Anthropic), API keys, request logs with the full
  upstream call chain, and a playground.

Everything is stored in one SQLite file. Configuration changes apply
immediately, without a restart.

## Run with Docker

```bash
curl -O https://raw.githubusercontent.com/fl0w1nd/seekmux/main/docker-compose.yml
docker compose up -d
docker compose logs seekmux     # prints a one-time setup token
```

Open `http://127.0.0.1:8787` and use the token to set the admin password.
Images for `linux/amd64` and `linux/arm64` are at `ghcr.io/fl0w1nd/seekmux`;
everything the gateway stores is in the `./data` volume.

## Build

Needs Go 1.27+ and pnpm.

```bash
make build          # web UI + bin/seekmux
make linux          # static linux/amd64 and linux/arm64 binaries
make test
```

## Run

```bash
./bin/seekmux serve --addr :8787 --data ./data
```

On first start the log prints a one-time setup token; open the console and
use it to set the admin password. Alternatively set `SEEKMUX_ADMIN_PASSWORD`
(10+ characters) before the first start.

| Flag | Environment | Default |
| --- | --- | --- |
| `--addr` | `SEEKMUX_ADDR` | `:8787` |
| `--data` | `SEEKMUX_DATA_DIR` | `./data` |

Other commands:

```bash
seekmux export > seekmux.yaml     # configuration as YAML (contains API keys)
seekmux import seekmux.yaml       # replace the configuration
seekmux import-env old/.env       # migrate the settings of the old stdio tool
seekmux reset-password            # forget the admin password, print a new setup token
seekmux healthcheck               # exit 0 when the gateway answers (used by the image)
```

## Connect an agent

Create an API key in the console (Access keys), then:

```bash
claude mcp add --transport http seekmux https://your-host/mcp --header "Authorization: Bearer smx_..."
```

Keys can be limited to specific tools and given their own rate limit.

## Deploy

Run it behind a TLS-terminating reverse proxy. Two things to set there:

- no response buffering for `/mcp` and `/api/logs/stream` (both stream);
- a read timeout longer than your research time budget (default 5 minutes),
  or have agents use `research_start` / `research_result` instead.

```
[Unit]
Description=SeekMux
After=network-online.target

[Service]
ExecStart=/opt/seekmux/seekmux serve --addr 127.0.0.1:8787 --data /var/lib/seekmux
Restart=on-failure
DynamicUser=yes
StateDirectory=seekmux

[Install]
WantedBy=multi-user.target
```

## Layout

```
cmd/seekmux        entry point and CLI
internal/config    configuration model, validation, YAML
internal/core      rate limiter, fallback and hedged runners, tracing, cache
internal/search    search providers
internal/fetch     fetch providers, extraction, paging
internal/llm       model access through charm.land/fantasy
internal/research  the research agent
internal/store     SQLite: config, keys, sessions, logs, tasks
internal/app       wiring; applies configuration snapshots
internal/mcpsrv    MCP server
internal/admin     console API and auth
web                console (React); design system in web/DESIGN.md
```

## Releases

Pushing a tag `vX.Y.Z` builds the multi-architecture image, publishes it to
GHCR and creates a GitHub release whose notes are the commit subjects since
the previous tag. Commits follow Conventional Commits (`feat:`, `fix:`, ...);
`ci`, `build`, `chore`, `docs`, `test` and `style` commits stay out of the notes.
