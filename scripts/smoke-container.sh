#!/usr/bin/env bash
# Starts the image on an empty data directory and waits for it to serve.
set -euo pipefail

image="${1:?usage: smoke-container.sh <image>}"
data="$(mktemp -d)"
trap 'docker rm -f seekmux-smoke >/dev/null 2>&1 || true; rm -rf "$data"' EXIT
chmod -R a+rwX "$data"

# Run as the invoking user, so the cleanup above can remove what it wrote.
docker run -d --name seekmux-smoke --user "$(id -u):$(id -g)" \
  -p 18787:8787 -v "$data:/data" "$image" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18787/healthz >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:18787/ | grep -qi "<html"
    curl -fsS http://127.0.0.1:18787/api/auth/state | grep -q '"setup_required":true'
    # Without a key the MCP endpoint must refuse.
    [[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18787/mcp)" == "401" ]]
    docker exec seekmux-smoke seekmux healthcheck
    echo "container is healthy"
    exit 0
  fi
  sleep 1
done

docker logs seekmux-smoke >&2
echo "container did not become healthy" >&2
exit 1
