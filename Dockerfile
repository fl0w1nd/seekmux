# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:lts-alpine AS web-builder

WORKDIR /build/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN npm install -g pnpm@10.33.0 && pnpm install --frozen-lockfile

COPY web ./
RUN pnpm build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY cmd ./cmd
COPY internal ./internal
# The console is embedded in the binary.
COPY web/embed.go ./web/
COPY --from=web-builder /build/web/dist ./web/dist

ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /seekmux ./cmd/seekmux

FROM gcr.io/distroless/static-debian12

ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="SeekMux" \
      org.opencontainers.image.description="Search, fetch and research gateway for AI agents" \
      org.opencontainers.image.source="https://github.com/fl0w1nd/seekmux" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$COMMIT \
      org.opencontainers.image.created=$BUILD_DATE

COPY --from=builder /seekmux /usr/local/bin/seekmux

ENV SEEKMUX_ADDR=:8787 \
    SEEKMUX_DATA_DIR=/data

# The SQLite database, and with it all configuration, lives in /data.
VOLUME ["/data"]
WORKDIR /data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["seekmux", "healthcheck"]

ENTRYPOINT ["seekmux"]
CMD ["serve"]
