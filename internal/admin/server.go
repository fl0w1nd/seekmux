package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fl0w1nd/seekmux/internal/app"
	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/fetch"
	"github.com/fl0w1nd/seekmux/internal/llm"
	"github.com/fl0w1nd/seekmux/internal/research"
	"github.com/fl0w1nd/seekmux/internal/search"
	"github.com/fl0w1nd/seekmux/internal/store"
)

type Server struct {
	app     *app.App
	version string
	assets  fs.FS

	setupMu    sync.Mutex
	setupToken string
}

// New returns the admin server. assets holds the built WebUI.
func New(a *app.App, version string, assets fs.FS) *Server {
	return &Server{app: a, version: version, assets: assets}
}

// Handler serves /api/ and the WebUI.
func (s *Server) Handler() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/auth/state", s.handleAuthState)
	api.HandleFunc("POST /api/auth/setup", s.handleSetup)
	api.HandleFunc("POST /api/auth/login", s.handleLogin)
	api.HandleFunc("POST /api/auth/logout", s.handleLogout)
	api.HandleFunc("POST /api/auth/password", s.requireAuth(s.handlePassword))

	for pattern, handler := range map[string]http.HandlerFunc{
		"GET /api/meta":                s.handleMeta,
		"GET /api/config":              s.handleGetConfig,
		"PUT /api/config":              s.handlePutConfig,
		"GET /api/config/export":       s.handleExport,
		"POST /api/config/import":      s.handleImport,
		"POST /api/breaker/reset":      s.handleBreakerReset,
		"GET /api/status":              s.handleStatus,
		"GET /api/keys":                s.handleListKeys,
		"POST /api/keys":               s.handleCreateKey,
		"PATCH /api/keys/{id}":         s.handleUpdateKey,
		"POST /api/keys/{id}/revoke":   s.handleRevokeKey,
		"DELETE /api/keys/{id}":        s.handleDeleteKey,
		"GET /api/logs":                s.handleListLogs,
		"GET /api/logs/stream":         s.handleLogStream,
		"GET /api/logs/{id}":           s.handleGetLog,
		"DELETE /api/logs":             s.handleClearLogs,
		"GET /api/stats":               s.handleStats,
		"POST /api/cache/clear":        s.handleClearCache,
		"POST /api/play/search":        s.handlePlaySearch,
		"POST /api/play/dev_search":    s.handlePlayDevSearch,
		"POST /api/play/fetch":         s.handlePlayFetch,
		"POST /api/play/research":      s.handlePlayResearch,
		"POST /api/play/model":         s.handlePlayModel,
		"GET /api/research/tasks/{id}": s.handleGetTask,
		"POST /api/research/tasks":     s.handleStartTask,
	} {
		api.HandleFunc(pattern, s.requireAuth(handler))
	}
	api.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, errors.New("no such endpoint"))
	})

	// The session cookie is SameSite=Strict; this also rejects cross-origin
	// writes from browsers that would send it anyway.
	protected := http.NewCrossOriginProtection().Handler(api)

	mux := http.NewServeMux()
	mux.Handle("/api/", protected)
	mux.Handle("/", s.spa())
	return mux
}

// spa serves the built WebUI, falling back to index.html for client routes.
func (s *Server) spa() http.Handler {
	files := http.FileServerFS(s.assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		if _, err := fs.Stat(s.assets, name); err != nil {
			name = "index.html"
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(name, "assets/") {
			// Vite fingerprints everything under assets/.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if name == "index.html" {
			data, err := fs.ReadFile(s.assets, name)
			if err != nil {
				http.Error(w, "the WebUI is not built; run `pnpm --dir web build`", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(data)
			return
		}
		r.URL.Path = "/" + name
		files.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid request body: %w", err))
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid id"))
	}
	return id, err == nil
}

var webui = app.Caller{Source: app.SourceWebUI}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"version":           s.version,
		"catalog":           config.Catalog,
		"tools":             config.Tools,
		"defaults":          config.Default(),
		"reasoning_efforts": config.ReasoningEfforts,
		"prompts": map[string]string{
			"extract":  fetch.DefaultSystemPrompt,
			"research": research.DefaultSystemPrompt,
		},
	})
}

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.app.Snapshot().Config.Redacted())
}

func (s *Server) handlePutConfig(w http.ResponseWriter, r *http.Request) {
	var cfg config.Config
	if !readJSON(w, r, &cfg) {
		return
	}
	cfg.MergeSecrets(s.app.Snapshot().Config)
	if err := s.app.SaveConfig(r.Context(), &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, s.app.Snapshot().Config.Redacted())
}

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	data, err := s.app.Snapshot().Config.ToYAML()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	header := "# SeekMux configuration export. Contains API keys in plain text.\n"
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="seekmux-config.yaml"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, header)
	_, _ = w.Write(data)
}

func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	cfg, err := config.FromYAML(data)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := s.app.SaveConfig(r.Context(), cfg); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, s.app.Snapshot().Config.Redacted())
}

type keyBody struct {
	Name      string   `json:"name"`
	Scopes    []string `json:"scopes"`
	RateLimit string   `json:"rate_limit"`
}

func (b *keyBody) validate() error {
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" || len(b.Name) > 64 {
		return errors.New("name is required, at most 64 characters")
	}
	if len(b.Scopes) == 0 {
		return errors.New("select at least one tool")
	}
	for _, scope := range b.Scopes {
		if !slices.Contains(config.Tools, scope) {
			return fmt.Errorf("unknown tool %q", scope)
		}
	}
	b.RateLimit = strings.TrimSpace(b.RateLimit)
	_, err := config.ParseRateLimit(b.RateLimit)
	return err
}

func (s *Server) handleListKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := s.app.Store.ListAPIKeys(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, keys)
}

func (s *Server) handleCreateKey(w http.ResponseWriter, r *http.Request) {
	var body keyBody
	if !readJSON(w, r, &body) {
		return
	}
	if err := body.validate(); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	key, secret, err := s.app.Store.CreateAPIKey(r.Context(), body.Name, body.Scopes, body.RateLimit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"key": key, "secret": secret})
}

func (s *Server) handleUpdateKey(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	var body keyBody
	if !ok || !readJSON(w, r, &body) {
		return
	}
	if err := body.validate(); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := s.app.Store.UpdateAPIKey(r.Context(), id, body.Name, body.Scopes, body.RateLimit); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleRevokeKey(w http.ResponseWriter, r *http.Request) {
	if id, ok := pathID(w, r); ok {
		if err := s.app.Store.RevokeAPIKey(r.Context(), id); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	}
}

func (s *Server) handleDeleteKey(w http.ResponseWriter, r *http.Request) {
	if id, ok := pathID(w, r); ok {
		if err := s.app.Store.DeleteAPIKey(r.Context(), id); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	}
}

func (s *Server) handleListLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	entries, err := s.app.Store.ListLogs(r.Context(), store.LogFilter{
		Tool: q.Get("tool"), Status: q.Get("status"), Provider: q.Get("provider"), Source: q.Get("source"),
		Query: strings.TrimSpace(q.Get("q")), Fallback: q.Get("fallback") == "1", Before: before, Limit: limit,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, entries)
}

func (s *Server) handleGetLog(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	entry, found, err := s.app.Store.GetLog(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, errors.New("log entry not found"))
		return
	}
	writeJSON(w, entry)
}

func (s *Server) handleClearLogs(w http.ResponseWriter, r *http.Request) {
	if err := s.app.Store.ClearLogs(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleLogStream pushes new log entries as server-sent events.
func (s *Server) handleLogStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errors.New("streaming is not supported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	entries, cancel := s.app.Logs.Subscribe()
	defer cancel()
	_, _ = io.WriteString(w, ": connected\n\n")
	flusher.Flush()

	keepAlive := time.NewTicker(20 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case entry := <-entries:
			data, _ := json.Marshal(entry)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
		case <-keepAlive.C:
			_, _ = io.WriteString(w, ": ping\n\n")
		case <-r.Context().Done():
			return
		}
		flusher.Flush()
	}
}

// health is what the circuit breaker says about a provider or model.
type health struct {
	Disabled bool `json:"disabled"`
	// DisabledReason is "provider" for repeated failures, or the account
	// problem: "auth", "quota".
	DisabledReason string `json:"disabled_reason,omitempty"`
	// DisabledMs is how much longer it stays off; 0 while Disabled means
	// until it is re-enabled.
	DisabledMs int64 `json:"disabled_ms"`
	// DisabledDetail is what the upstream answered, for account problems.
	DisabledDetail string `json:"disabled_detail,omitempty"`
}

func (s *Server) health(key string) health {
	trip, off := s.app.Limits.Breaker.State(key)
	if !off {
		return health{}
	}
	h := health{Disabled: true, DisabledReason: string(trip.Reason), DisabledDetail: trip.Detail}
	if !trip.Until.IsZero() {
		h.DisabledMs = max(time.Until(trip.Until).Milliseconds(), 1)
	}
	return h
}

type routeStatus struct {
	// Key identifies the breaker state, for /api/breaker/reset.
	Key string `json:"key"`
	health
	Tool      string `json:"tool"`
	Provider  string `json:"provider"`
	Available bool   `json:"available"`
	Enabled   bool   `json:"enabled"`
	// The limits and their use are the provider's, shared by all its routes.
	RateLimit   string `json:"rate_limit"`
	Used        int    `json:"used"`
	Limit       int    `json:"limit"`
	Active      int    `json:"active"`
	Concurrency int    `json:"concurrency"`
}

func (s *Server) routeStatuses(cfg *config.Config) []routeStatus {
	out := []routeStatus{}
	add := func(tool string, routes []config.Route) {
		for _, route := range routes {
			info, _ := config.Info(route.Provider)
			limit, concurrency := cfg.Limits(route.Provider)
			key := route.Provider + ":" + tool
			out = append(out, routeStatus{
				Key: key, health: s.health(key),
				Tool: tool, Provider: route.Provider, Enabled: route.Enabled,
				Available:   route.Enabled && (cfg.Providers[route.Provider].APIKey != "" || !info.KeyRequired),
				RateLimit:   *cfg.Providers[route.Provider].RateLimit,
				Used:        s.app.Limits.Rate.Used(route.Provider, limit),
				Limit:       limit.Requests,
				Active:      s.app.Limits.Concurrency.Active(route.Provider),
				Concurrency: concurrency,
			})
		}
	}
	add(config.ToolSearch, cfg.Search.Routes)
	add(config.ToolDevSearch, cfg.DevSearch.Routes)
	add(config.ToolFetch, cfg.Fetch.Routes)
	return out
}

type modelStatus struct {
	// Key identifies the limits and the breaker state, for /api/breaker/reset.
	Key string `json:"key"`
	health
	ID          string `json:"id"`
	Provider    string `json:"provider"`
	Name        string `json:"name"`
	RateLimit   string `json:"rate_limit"`
	Used        int    `json:"used"`
	Limit       int    `json:"limit"`
	Active      int    `json:"active"`
	Concurrency int    `json:"concurrency"`
	// Roles names the features using the model: "extract", "research".
	Roles []string `json:"roles"`
}

func (s *Server) modelStatuses(cfg *config.Config) []modelStatus {
	out := []modelStatus{}
	for _, p := range cfg.LLM.Providers {
		for _, m := range p.Models {
			limit, _ := config.ParseRateLimit(m.RateLimit)
			key := llm.LimitKey(m.ID)
			status := modelStatus{
				Key: key, health: s.health(key),
				ID: m.ID, Provider: p.ID, Name: m.Name, RateLimit: m.RateLimit,
				Used: s.app.Limits.Rate.Used(key, limit), Limit: limit.Requests,
				Active: s.app.Limits.Concurrency.Active(key), Concurrency: m.Concurrency,
				Roles: []string{},
			}
			if slices.Contains(cfg.Fetch.Extract.Models, m.ID) {
				status.Roles = append(status.Roles, "extract")
			}
			if cfg.Research.Model == m.ID {
				status.Roles = append(status.Roles, "research")
			}
			out = append(out, status)
		}
	}
	return out
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	window, bucket := 24*time.Hour, time.Hour
	switch r.URL.Query().Get("window") {
	case "1h":
		window, bucket = time.Hour, 5*time.Minute
	case "7d":
		window, bucket = 7*24*time.Hour, 6*time.Hour
	}
	stats, err := s.app.Store.Stats(r.Context(), window, bucket)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	snap := s.app.Snapshot()
	pages, bytes := s.app.FetchCacheStats()
	writeJSON(w, map[string]any{
		"stats":  stats,
		"routes": s.routeStatuses(snap.Config),
		"models": s.modelStatuses(snap.Config),
		"cache":  map[string]int{"pages": pages, "bytes": bytes},
		"roles": map[string]any{
			"extract":  snap.Config.Fetch.Extract.Configured(),
			"research": app.ResearchAvailable(snap),
		},
	})
}

// handleStatus reports the limits and health of every provider and model,
// for the pages that configure them.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	cfg := s.app.Snapshot().Config
	writeJSON(w, map[string]any{"routes": s.routeStatuses(cfg), "models": s.modelStatuses(cfg)})
}

// handleBreakerReset re-enables a provider or model the breaker switched off.
func (s *Server) handleBreakerReset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key string `json:"key"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	s.app.Limits.Breaker.Reset(body.Key)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleClearCache(w http.ResponseWriter, r *http.Request) {
	s.app.ClearFetchCache()
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handlePlaySearch(w http.ResponseWriter, r *http.Request) {
	var args search.Args
	if !readJSON(w, r, &args) {
		return
	}
	trace := core.NewTrace()
	results, err := s.app.Search(core.WithTrace(r.Context(), trace), webui, args)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, map[string]any{"duration_ms": time.Since(trace.Start).Milliseconds(), "results": results, "attempts": trace.Attempts()})
}

func (s *Server) handlePlayDevSearch(w http.ResponseWriter, r *http.Request) {
	var args search.DevArgs
	if !readJSON(w, r, &args) {
		return
	}
	trace := core.NewTrace()
	result, err := s.app.DevSearch(core.WithTrace(r.Context(), trace), webui, args)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, map[string]any{"duration_ms": time.Since(trace.Start).Milliseconds(), "result": result, "attempts": trace.Attempts()})
}

func (s *Server) handlePlayFetch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		fetch.Args
		// Model answers in place of the extract chain, to try it before assigning it.
		Model string `json:"model"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	trace := core.NewTrace()
	result, err := s.app.Fetch(core.WithTrace(r.Context(), trace), webui, body.Args, app.Override{ExtractModel: body.Model})
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, map[string]any{"duration_ms": time.Since(trace.Start).Milliseconds(), "result": result, "attempts": trace.Attempts()})
}

func (s *Server) handlePlayResearch(w http.ResponseWriter, r *http.Request) {
	var body researchBody
	if !readJSON(w, r, &body) {
		return
	}
	started := time.Now()
	result, err := s.app.Research(r.Context(), webui, body.Question, app.Override{ResearchModel: body.Model}, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, map[string]any{"duration_ms": time.Since(started).Milliseconds(), "result": result})
}

// researchBody starts research from the console.
type researchBody struct {
	Question string `json:"question"`
	// Model runs the agent in place of the configured model, to try it.
	Model string `json:"model"`
}

func (s *Server) handleStartTask(w http.ResponseWriter, r *http.Request) {
	var body researchBody
	if !readJSON(w, r, &body) {
		return
	}
	id, err := s.app.StartResearch(r.Context(), webui, body.Question, app.Override{ResearchModel: body.Model})
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, map[string]string{"task_id": id})
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	task, found, err := s.app.Store.GetTask(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, errors.New("task not found"))
		return
	}
	writeJSON(w, task)
}

// handlePlayModel sends a one-line prompt to a model so the WebUI can verify
// an LLM provider and a model before saving them. The body carries both as
// edited in the form, which may differ from the stored configuration.
func (s *Server) handlePlayModel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Provider config.LLMProvider `json:"provider"`
		Model    config.Model       `json:"model"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	snap := s.app.Snapshot()
	current, _ := snap.Config.LLMProviderByID(body.Provider.ID)
	candidate := body.Provider
	if candidate.APIKey == "" && !candidate.ClearAPIKey {
		candidate.APIKey = current.APIKey
	}
	body.Model.ID, body.Model.RateLimit = "test", ""
	candidate.Models = []config.Model{body.Model}
	cfg := &config.Config{LLM: config.LLM{Providers: []config.LLMProvider{candidate}}}

	model, err := llm.NewModel(r.Context(), cfg, body.Model.ID, snap.Client)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	started := time.Now()
	result, err := model.Chat(r.Context(), "You are a connection test. Follow the instruction exactly.", "Reply with the single word: pong", llm.ChatOptions{
		FirstChunkTimeout: 20 * time.Second, TotalTimeout: 40 * time.Second, MaxRetries: 1,
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"duration_ms": time.Since(started).Milliseconds(), "reply": result.Text})
}
