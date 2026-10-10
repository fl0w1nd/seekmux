// Package app is the gateway itself: it holds the live configuration and
// serves the tools, independent of how a call arrives (MCP or the WebUI).
package app

import (
	"context"
	"encoding/json"
	"errors"
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
	// running holds the cancel function of every research task under way,
	// by task id.
	running sync.Map
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

// Override replaces parts of the configuration for a single call. The
// console uses it to try a model, a budget or a provider's parameters before
// saving them; tool calls over MCP never carry one.
type Override struct {
	// ExtractModel answers fetch prompts on its own, in place of the
	// extract chain.
	ExtractModel string
	// ResearchModel runs the research agent.
	ResearchModel string
	// Research replaces the limits of a research run.
	Research ResearchOverride
	// Route replaces the parameters of one provider of the tool called.
	Route *RouteOverride
	// Pin leaves this provider alone to serve the call, for a tool that
	// takes no engine argument.
	Pin string
	// NoCache makes fetch read the page anew and keep it out of the cache.
	NoCache bool
}

// ResearchOverride holds the research settings a run may replace; a zero
// field keeps what is configured.
type ResearchOverride struct {
	Reading            string `json:"reading"`
	MaxSteps           int    `json:"max_steps"`
	MaxDurationSeconds int    `json:"max_duration_seconds"`
	MaxTokens          int64  `json:"max_tokens"`
	MaxContextTokens   int64  `json:"max_context_tokens"`
}

// RouteOverride holds a route's parameters as they should be for one call.
type RouteOverride struct {
	Provider  string         `json:"provider"`
	Options   map[string]any `json:"options"`
	ExtraBody map[string]any `json:"extra_body"`
}

// The ceilings of an overridden research budget: a run is bounded even when
// a number is mistyped.
const (
	maxResearchSteps    = 200
	maxResearchDuration = 3600
)

func (o ResearchOverride) apply(r *config.Research) error {
	switch {
	case o.Reading != "" && o.Reading != config.ReadingRaw && o.Reading != config.ReadingExtract:
		return fmt.Errorf("reading must be %q or %q", config.ReadingRaw, config.ReadingExtract)
	case o.MaxSteps < 0 || o.MaxSteps > maxResearchSteps:
		return fmt.Errorf("max_steps must be between 1 and %d", maxResearchSteps)
	case o.MaxDurationSeconds < 0 || o.MaxDurationSeconds > maxResearchDuration:
		return fmt.Errorf("max_duration_seconds must be between 1 and %d", maxResearchDuration)
	case o.MaxTokens < 0 || o.MaxContextTokens < 0:
		return fmt.Errorf("token limits must be positive")
	}
	if o.Reading != "" {
		r.Reading = o.Reading
	}
	if o.MaxSteps > 0 {
		r.MaxSteps = o.MaxSteps
	}
	if o.MaxDurationSeconds > 0 {
		r.MaxDurationSeconds = o.MaxDurationSeconds
	}
	if o.MaxTokens > 0 {
		r.MaxTokens = o.MaxTokens
	}
	if o.MaxContextTokens > 0 {
		r.MaxContextTokens = o.MaxContextTokens
	}
	return nil
}

// with returns s with o applied to a call of tool, or s itself when o
// changes nothing.
func (s *Snapshot) with(tool string, o Override) (*Snapshot, error) {
	if o.ExtractModel == "" && o.ResearchModel == "" && o.Research == (ResearchOverride{}) && o.Route == nil && o.Pin == "" {
		return s, nil
	}
	cfg := s.Config.Clone()
	for _, id := range []string{o.ExtractModel, o.ResearchModel} {
		if _, _, ok := cfg.ModelByID(id); id != "" && !ok {
			return nil, fmt.Errorf("model %q does not exist", id)
		}
	}
	if o.ExtractModel != "" {
		cfg.Fetch.Extract.Models = []string{o.ExtractModel}
	}
	if o.ResearchModel != "" {
		cfg.Research.Model = o.ResearchModel
	}
	if err := o.Research.apply(&cfg.Research); err != nil {
		return nil, err
	}
	if o.Route != nil {
		if err := cfg.TuneRoute(tool, o.Route.Provider, o.Route.Options, o.Route.ExtraBody); err != nil {
			return nil, err
		}
	}
	if o.Pin != "" {
		if err := cfg.PinRoute(tool, o.Pin); err != nil {
			return nil, err
		}
	}
	return &Snapshot{Version: s.Version, Config: cfg, Client: s.Client}, nil
}

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

func (a *App) fetchRuntime(s *Snapshot, o Override) fetch.Runtime {
	// A page read with parameters of its own must not answer later calls.
	return fetch.Runtime{Config: s.Config, Client: s.Client, LLMClient: s.Client, NoCache: o.NoCache || o.Route != nil}
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

// traced returns the trace of ctx, adding a new one when there is none. A
// caller that wants to show the upstream calls passes its own.
func traced(ctx context.Context) (context.Context, *core.Trace) {
	if trace := core.TraceFrom(ctx); trace != nil {
		return ctx, trace
	}
	trace := core.NewTrace()
	return core.WithTrace(ctx, trace), trace
}

// Search serves the search tool. The error is an invalid-arguments error.
// The upstream calls land in the trace of ctx when it carries one.
func (a *App) Search(ctx context.Context, caller Caller, args search.Args, o Override) ([]search.QueryResult, error) {
	s, err := a.Snapshot().with(config.ToolSearch, o)
	if err != nil {
		return nil, err
	}
	if err := args.Validate(s.Config); err != nil {
		return nil, err
	}
	ctx, trace := traced(ctx)
	results := search.Run(ctx, s.Config, s.Client, a.Limits, args)

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

// DevSearch serves the dev_search tool. The error is an invalid-arguments
// error. The upstream calls land in the trace of ctx when it carries one.
func (a *App) DevSearch(ctx context.Context, caller Caller, args search.DevArgs, o Override) (search.DevResult, error) {
	s, err := a.Snapshot().with(config.ToolDevSearch, o)
	if err != nil {
		return search.DevResult{}, err
	}
	if err := args.Validate(s.Config); err != nil {
		return search.DevResult{}, err
	}
	ctx, trace := traced(ctx)
	result := search.RunDev(ctx, s.Config, s.Client, a.Limits, args)

	entry := store.LogEntry{Status: store.StatusOK, Summary: args.Query, Provider: result.Engine, Error: result.Error}
	if result.Error != "" {
		entry.Status = store.StatusError
	}
	a.logCall(s, caller, config.ToolDevSearch, trace, entry, args, result)
	return result, nil
}

// Fetch serves the fetch tool. The error is an invalid-arguments error.
// The upstream calls land in the trace of ctx when it carries one.
func (a *App) Fetch(ctx context.Context, caller Caller, args fetch.Args, o Override) (fetch.Result, error) {
	s, err := a.Snapshot().with(config.ToolFetch, o)
	if err != nil {
		return fetch.Result{}, err
	}
	if err := args.Validate(s.Config); err != nil {
		return fetch.Result{}, err
	}
	ctx, trace := traced(ctx)
	result := a.fetcher.Run(ctx, a.fetchRuntime(s, o), args)

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
func (a *App) Research(ctx context.Context, caller Caller, question string, o Override, progress func(research.Event)) (research.Result, error) {
	s, err := a.Snapshot().with(config.ToolResearch, o)
	if err != nil {
		return research.Result{}, err
	}
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
	report := func(event research.Event) {
		if progress != nil {
			progressMu.Lock()
			defer progressMu.Unlock()
			progress(event)
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
				return a.fetcher.Run(ctx, a.fetchRuntime(s, Override{}), args), nil
			},
		}
		if search.DevAvailable(s.Config) {
			tools.DevSearch = func(ctx context.Context, args search.DevArgs) (search.DevResult, error) {
				if err := args.Validate(s.Config); err != nil {
					return search.DevResult{}, err
				}
				return search.RunDev(ctx, s.Config, s.Client, a.Limits, args), nil
			}
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

// ResearchBudget is what a research task runs on, kept with the task.
type ResearchBudget struct {
	Model              string `json:"model"`
	Reading            string `json:"reading"`
	MaxSteps           int    `json:"max_steps"`
	MaxDurationSeconds int    `json:"max_duration_seconds"`
	MaxTokens          int64  `json:"max_tokens"`
	MaxContextTokens   int64  `json:"max_context_tokens"`
}

// StartResearch runs research in the background and returns the id of the
// task that holds its progress and its result.
func (a *App) StartResearch(ctx context.Context, caller Caller, question string, o Override) (string, error) {
	question = strings.TrimSpace(question)
	if question == "" {
		return "", fmt.Errorf("question is required")
	}
	s, err := a.Snapshot().with(config.ToolResearch, o)
	if err != nil {
		return "", err
	}
	if !ResearchAvailable(s) {
		return "", fmt.Errorf("research is not enabled")
	}
	r := s.Config.Research
	id := store.NewToken("rs_")
	if err := a.Store.CreateTask(ctx, id, question, ResearchBudget{
		Model: r.Model, Reading: r.Reading, MaxSteps: r.MaxSteps, MaxDurationSeconds: r.MaxDurationSeconds,
		MaxTokens: r.MaxTokens, MaxContextTokens: r.MaxContextTokens,
	}); err != nil {
		return "", err
	}
	run, cancel := context.WithCancelCause(a.background)
	a.running.Store(id, cancel)
	a.tasks.Go(func() {
		defer a.running.Delete(id)
		defer cancel(nil)
		result, err := a.Research(run, caller, question, o, func(event research.Event) {
			if event.Kind != "" {
				a.Store.AddTaskStep(a.background, id, store.TaskStep{Step: event.Step, Kind: event.Kind, Text: event.Text, Line: event.Line()})
			}
			a.Store.SetTaskSpent(a.background, id, event.Spent, event.Draft)
		})
		// A run that failed before its first step has no totals to show.
		var stats any
		if totals := result; totals != (research.Result{}) {
			totals.Report = ""
			stats = totals
		}
		status, message := store.TaskDone, ""
		switch {
		case context.Cause(run) == errCanceled:
			status, message = store.TaskCanceled, errCanceled.Error()
		case err != nil:
			status, message = store.TaskFailed, err.Error()
		}
		if ferr := a.Store.FinishTask(context.Background(), id, status, result.Report, message, stats); ferr != nil {
			slog.Error("store research result", "task", id, "error", ferr)
		}
	})
	return id, nil
}

var errCanceled = errors.New("the task was stopped")

// CancelResearch stops a research task under way. It reports whether the
// task was running.
func (a *App) CancelResearch(id string) bool {
	cancel, ok := a.running.Load(id)
	if ok {
		cancel.(context.CancelCauseFunc)(errCanceled)
	}
	return ok
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
