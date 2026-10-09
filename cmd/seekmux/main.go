// Command seekmux is a search and fetch gateway for AI agents: it multiplexes
// several providers behind MCP tools and is configured through a WebUI.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/fl0w1nd/seekmux/internal/admin"
	"github.com/fl0w1nd/seekmux/internal/app"
	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/mcpsrv"
	"github.com/fl0w1nd/seekmux/internal/store"
	"github.com/fl0w1nd/seekmux/web"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const usage = `Usage: seekmux [command] [flags]

Commands:
  serve                 Run the gateway (default)
  import-env <file>     Replace the configuration with one built from a legacy search-mcp .env file
  import <file>         Replace the configuration with a YAML export
  export                Print the configuration as YAML, API keys included
  reset-password        Remove the admin password; the next start prints a setup token
  healthcheck           Exit 0 when the gateway on the listen address answers

Flags and environment:
  --addr, SEEKMUX_ADDR             Listen address (default :8787)
  --data, SEEKMUX_DATA_DIR         Data directory (default ./data)
  SEEKMUX_ADMIN_PASSWORD           Admin password; when set it is applied on every start
`

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	command := "serve"
	args := os.Args[1:]
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		command, args = args[0], args[1:]
	}
	flags := flag.NewFlagSet("seekmux", flag.ExitOnError)
	flags.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	addr := flags.String("addr", env("SEEKMUX_ADDR", ":8787"), "listen address")
	dataDir := flags.String("data", env("SEEKMUX_DATA_DIR", "./data"), "data directory")
	_ = flags.Parse(args)

	if err := run(command, flags.Args(), *addr, *dataDir); err != nil {
		slog.Error(err.Error())
		os.Exit(1)
	}
}

func run(command string, args []string, addr, dataDir string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if command == "healthcheck" {
		return healthcheck(ctx, addr)
	}

	st, err := store.Open(dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	if command == "reset-password" {
		if err := st.Set(ctx, "admin_password", nil); err != nil {
			return err
		}
		_ = st.DeleteSessions(ctx, "")
		fmt.Println("Admin password removed. Start seekmux and use the setup token it prints.")
		return nil
	}

	a, err := app.New(ctx, st)
	if err != nil {
		return err
	}
	defer a.Close()

	switch command {
	case "serve":
		return serve(ctx, a, addr)
	case "export":
		data, err := a.Snapshot().Config.ToYAML()
		if err == nil {
			_, err = os.Stdout.Write(data)
		}
		return err
	case "import", "import-env":
		if len(args) != 1 {
			return fmt.Errorf("%s needs exactly one file argument", command)
		}
		cfg, err := load(command, args[0])
		if err != nil {
			return err
		}
		if err := a.SaveConfig(ctx, cfg); err != nil {
			return err
		}
		fmt.Printf("Configuration imported from %s\n", args[0])
		return nil
	}
	fmt.Fprint(os.Stderr, usage)
	return fmt.Errorf("unknown command %q", command)
}

func load(command, path string) (*config.Config, error) {
	if command == "import-env" {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		return config.FromLegacyEnv(file)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return config.FromYAML(data)
}

func serve(ctx context.Context, a *app.App, addr string) error {
	adminServer := admin.New(a, version, web.Assets())
	if err := adminServer.InitPassword(ctx, os.Getenv("SEEKMUX_ADMIN_PASSWORD")); err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.Handle("/mcp", mcpsrv.Handler(a, version))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	mux.Handle("/", adminServer.Handler())

	// No read or write timeout: MCP responses and the log stream are long-lived.
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go a.RunMaintenance(ctx)

	failed := make(chan error, 1)
	go func() { failed <- server.ListenAndServe() }()
	slog.Info("seekmux is listening", "addr", addr, "webui", "http://"+displayAddr(addr), "mcp", "http://"+displayAddr(addr)+"/mcp", "version", version)

	select {
	case err := <-failed:
		return err
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdown); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}

// healthcheck asks the gateway listening on addr whether it is up; the
// container image has no shell or curl to do it with.
func healthcheck(ctx context.Context, addr string) error {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort("127.0.0.1", port)+"/healthz", nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("unhealthy: %s", res.Status)
	}
	return nil
}

func displayAddr(addr string) string {
	if len(addr) > 0 && addr[0] == ':' {
		return "localhost" + addr
	}
	return addr
}
