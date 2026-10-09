// Package app is the gateway itself: it holds the live configuration and
// serves the tools, independent of how a call arrives (MCP or the WebUI).
package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/fetch"
	"github.com/fl0w1nd/seekmux/internal/llm"
	"github.com/fl0w1nd/seekmux/internal/research"
	"github.com/fl0w1nd/seekmux/internal/search"
	"github.com/fl0w1nd/seekmux/internal/store"
)

const configKey = "config"

// Snapshot is an immutable view of the configuration. A call keeps the
// snapshot it started with, so saving the configuration never disturbs calls
// in flight.
type Snapshot struct {
	// Version increases with every configuration change.
	Version int64
	Config  *config.Config
	Client  *http.Client
}

// Caller identifies who made a tool call, for the request log.
type Caller struct {
	Source  string
	KeyID   int64
	KeyName string
}

const (
	SourceMCP   = "mcp"
	SourceWebUI = "webui"
)

type App struct {
	Store  *store.Store
	Logs   *store.LogWriter
	Limits *core.Limits

	fetcher  *fetch.Service
	snapshot atomic.Pointer[Snapshot]
	saveMu   sync.Mutex
	// background bounds research tasks, which outlive the request that
	// started them but not the process.
	background context.Context
	stop       context.CancelFunc
	tasks      sync.WaitGroup
}

// New loads the stored configuration, creating the default one on first run.
func New(ctx context.Context, st *store.Store) (*App, error) {
	limits := core.NewLimits()
	a := &App{Store: st, Logs: st.NewLogWriter(), Limits: limits, fetcher: fetch.NewService(limits)}
	a.background, a.stop = context.WithCancel(context.Background())

	cfg := config.Default()
	raw, err := st.Get(ctx, configKey)
	if err != nil {
		return nil, err
	}
	if raw != nil {
		if cfg, err = config.FromStored(raw); err != nil {
			return nil, fmt.Errorf("stored configuration is unusable: %w", err)
		}
	}
	a.install(cfg)
	st.RecoverTasks(ctx)
	return a, nil
}

// Close stops background research and flushes the logs.
func (a *App) Close() {
	a.stop()
	a.tasks.Wait()
	a.Logs.Close()
}

func (a *App) Snapshot() *Snapshot { return a.snapshot.Load() }

func (a *App) install(cfg *config.Config) {
	var version int64 = 1
	if prev := a.snapshot.Load(); prev != nil {
		version = prev.Version + 1
		prev.Client.CloseIdleConnections()
	}
	a.Limits.Breaker.Configure(core.BreakerSettings{
		Enabled:  cfg.Breaker.Enabled,
		Failures: cfg.Breaker.Failures,
		Window:   time.Duration(cfg.Breaker.WindowSeconds) * time.Second,
		Cooldown: time.Duration(cfg.Breaker.CooldownSeconds) * time.Second,
	})
	a.snapshot.Store(&Snapshot{Version: version, Config: cfg, Client: newClient(cfg.Network.Proxy)})
}

// SaveConfig validates, persists and activates cfg. Limiter windows carry
// over, and so does the page cache unless the fetch routes changed.
func (a *App) SaveConfig(ctx context.Context, cfg *config.Config) error {
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	a.saveMu.Lock()
	defer a.saveMu.Unlock()
	if err := a.Store.Set(ctx, configKey, data); err != nil {
		return err
	}
	prev := a.Snapshot().Config
	a.install(cfg)
	if reflect.DeepEqual(prev.Fetch.Routes, cfg.Fetch.Routes) {
		a.fetcher.ClearAnswers()
	} else {
		// A provider's options change what it returns for the same URL.
		a.fetcher.ClearCache()
	}
	return nil
}

func newClient(proxy string) *http.Client {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	if proxy != "" {
		if u, err := url.Parse(proxy); err == nil {
			transport.Proxy = http.ProxyURL(u)
		}
	}
	// No client timeout: every call carries its own deadline.
	return &http.Client{Transport: transport}
}

func (a *App) fetchRuntime(s *Snapshot) fetch.Runtime {
	return fetch.Runtime{Config: s.Config, Client: s.Client, LLMClient: s.Client}
}

// logCall writes the request log entry of a finished tool call.
func (a *App) logCall(s *Snapshot, caller Caller, tool string, trace *core.Trace, entry store.LogEntry, request, response any) {
	entry.TS = trace.Start.UnixMilli()
	entry.Tool = tool
	entry.Source = caller.Source
	entry.APIKeyID, entry.APIKeyName = caller.KeyID, caller.KeyName
	entry.DurationMs = time.Since(trace.Start).Milliseconds()
	entry.Usage = trace.Usage()
	entry.Attempts, _ = json.Marshal(trace.Attempts())
	entry.Request = capture(request, 8<<10)
	if s.Config.Logs.CaptureBody {
		entry.Response = capture(response, 24<<10)
	}
	entry.Summary = truncate(entry.Summary, 500)
	entry.Error = truncate(entry.Error, 2000)
	a.Logs.Write(entry)
}

func capture(v any, limit int) string {
	if v == nil {
		return ""
	}
	data, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return truncate(string(data), limit)
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}

// Search serves the search tool. The error is an invalid-arguments error.
func (a *App) Search(ctx context.Context, caller Caller, args search.Args) ([]search.QueryResult, error) {
	s := a.Snapshot()
	if err := args.Validate(s.Config); err != nil {
		return nil, err
	}
	trace := core.NewTrace()
	results := search.Run(core.WithTrace(ctx, trace), s.Config, s.Client, a.Limits, args)

	entry := store.LogEntry{Status: store.StatusError, Summary: strings.Join(args.Queries, " | ")}
	var engines []string
	for _, r := range results {
		if r.Error == "" {
			entry.Status = store.StatusOK
			if !slices.Contains(engines, r.Engine) {
				engines = append(engines, r.Engine)
			}
		} else if entry.Error == "" {
			entry.Error = r.Error
		}
	}
	entry.Provider = strings.Join(engines, ",")
	a.logCall(s, caller, config.ToolSearch, trace, entry, args, results)
	return results, nil
}

// Fetch serves the fetch tool. The error is an invalid-arguments error.
func (a *App) Fetch(ctx context.Context, caller Caller, args fetch.Args) (fetch.Result, error) {
	s := a.Snapshot()
	if err := args.Validate(s.Config); err != nil {
		return fetch.Result{}, err
	}
	trace := core.NewTrace()
	result := a.fetcher.Run(core.WithTrace(ctx, trace), a.fetchRuntime(s), args)

	entry := store.LogEntry{Status: store.StatusOK, Summary: args.URL, Provider: result.Engine, Error: result.Error}
	if result.Error != "" {
		entry.Status = store.StatusError
	}
	a.logCall(s, caller, config.ToolFetch, trace, entry, args, result)
	return result, nil
}

// ClearFetchCache drops the cached pages and answers.
func (a *App) ClearFetchCache() { a.fetcher.ClearCache() }

// FetchCacheStats returns the number of cached pages and their size in bytes.
func (a *App) FetchCacheStats() (entries, bytes int) { return a.fetcher.CacheStats() }

// ResearchAvailable reports whether the research tool can run under s.
func ResearchAvailable(s *Snapshot) bool {
	return s.Config.Research.Enabled && s.Config.Research.Configured()
}

// Research runs the research agent to completion. progress may be nil.
func (a *App) Research(ctx context.Context, caller Caller, question string, progress func(string)) (research.Result, error) {
	s := a.Snapshot()
	question = strings.TrimSpace(question)
	if question == "" {
		return research.Result{}, fmt.Errorf("question is required")
	}
	if !ResearchAvailable(s) {
		return research.Result{}, fmt.Errorf("research is not enabled")
	}

	trace := core.NewTrace()
	ctx = core.WithTrace(ctx, trace)
	var progressMu sync.Mutex
	report := func(line string) {
		if progress != nil {
			progressMu.Lock()
			defer progressMu.Unlock()
			progress(line)
		}
	}

	var result research.Result
	model, err := llm.NewModel(ctx, s.Config, s.Config.Research.Model, s.Client)
	if err == nil {
		// The agent's own tool calls run against the same snapshot and land
		// in this call's trace instead of the request log.
		tools := research.Tools{
			Search: func(ctx context.Context, args search.Args) ([]search.QueryResult, error) {
				if err := args.Validate(s.Config); err != nil {
					return nil, err
				}
				return search.Run(ctx, s.Config, s.Client, a.Limits, args), nil
			},
			Fetch: func(ctx context.Context, args fetch.Args) (fetch.Result, error) {
				if err := args.Validate(s.Config); err != nil {
					return fetch.Result{}, err
				}
				return a.fetcher.Run(ctx, a.fetchRuntime(s), args), nil
			},
		}
		// Every request the agent makes counts against the model's limits.
		result, err = research.Run(ctx, s.Config.Research, model.Limited(a.Limits), tools, question, report)
	}

	entry := store.LogEntry{Status: store.StatusOK, Summary: question, Provider: s.Config.Research.Model}
	if err != nil {
		entry.Status, entry.Error = store.StatusError, err.Error()
	}
	a.logCall(s, caller, config.ToolResearch, trace, entry, map[string]string{"question": question}, result)
	return result, err
}

// StartResearch runs research in the background and returns the task id to
// poll with ResearchTask.
func (a *App) StartResearch(ctx context.Context, caller Caller, question string) (string, error) {
	question = strings.TrimSpace(question)
	if question == "" {
		return "", fmt.Errorf("question is required")
	}
	if !ResearchAvailable(a.Snapshot()) {
		return "", fmt.Errorf("research is not enabled")
	}
	id := store.NewToken("rs_")
	if err := a.Store.CreateTask(ctx, id, question); err != nil {
		return "", err
	}
	a.tasks.Go(func() {
		result, err := a.Research(a.background, caller, question, func(line string) {
			a.Store.SetTaskProgress(a.background, id, line)
		})
		if ferr := a.Store.FinishTask(context.Background(), id, result.Report, err); ferr != nil {
			slog.Error("store research result", "task", id, "error", ferr)
		}
	})
	return id, nil
}

// RunMaintenance prunes logs, sessions and old research tasks until ctx ends.
func (a *App) RunMaintenance(ctx context.Context) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		logs := a.Snapshot().Config.Logs
		a.Store.Prune(ctx, logs.RetentionDays, logs.MaxRows)
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
	}
}
