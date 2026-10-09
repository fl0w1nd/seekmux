VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build web server dev test linux clean

build: web server

web:
	pnpm --dir web install --frozen-lockfile
	pnpm --dir web build

server:
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/seekmux ./cmd/seekmux

# Static binaries for a remote server; SQLite is pure Go, so no cgo is needed.
linux: web
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/seekmux-linux-amd64 ./cmd/seekmux
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/seekmux-linux-arm64 ./cmd/seekmux

# Backend on :8787, UI with hot reload on :5173 (proxies /api and /mcp).
dev:
	go run ./cmd/seekmux serve & pnpm --dir web dev

test:
	go vet ./... && go test ./...
	pnpm --dir web exec tsc --noEmit

clean:
	rm -rf bin web/dist/assets web/dist/index.html
