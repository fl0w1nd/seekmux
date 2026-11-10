package fetch

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/worker"
)

func findNode(t *testing.T, trace *core.Trace, kind, name string) core.Node {
	t.Helper()
	for _, n := range trace.Nodes() {
		if n.Kind == kind && (name == "" || n.Name == name) {
			return n
		}
	}
	t.Fatalf("no %s/%s in %+v", kind, name, trace.Nodes())
	return core.Node{}
}

func TestFetchDecisionNodes(t *testing.T) {
	for _, tc := range []struct {
		name, url, text string
		raw, model      bool
		decision        string
	}{
		{"raw", "https://example.test/page", "long text", true, false, "raw"},
		{"source", "https://example.test/main.go", "long source", false, false, "source_code"},
		{"short", "https://example.test/page", "hi", false, false, "passthrough"},
		{"unconfigured", "https://example.test/page", "long text", false, false, "no_model"},
		{"extract fallback", "https://example.test/page", "long text", false, true, "extract"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := config.Default()
			cfg.Fetch.PassthroughLength = 3
			if tc.model {
				cfg.Fetch.Extract.Models = []string{"missing"}
				cfg.Fetch.Extract.RawOnFailure = true
			}
			s := NewService(core.NewLimits())
			s.pages.Set(tc.url, Page{Engine: "jina", Content: tc.text, Title: "fake"}, time.Minute)
			trace := core.NewTrace()
			result := s.Run(core.WithTrace(context.Background(), trace), Runtime{Config: cfg}, Args{URL: tc.url, Prompt: "question", Raw: tc.raw, Engine: EngineAuto})
			if result.Error != "" || result.Text == "" {
				t.Fatalf("result=%+v", result)
			}
			cache := findNode(t, trace, "cache", "page")
			if cache.Status != "cached" || cache.Attrs["hit"] != true {
				t.Fatalf("cache=%+v", cache)
			}
			decide := findNode(t, trace, "decide", tc.decision)
			if decide.Attrs["offset"] != 0 || decide.Attrs["length"] == nil || decide.Attrs["raw_page_length"] == nil {
				t.Fatalf("decide=%+v", decide)
			}
			if tc.model {
				extract := findNode(t, trace, "extract", "")
				if extract.Attrs["fallback"] != "raw" || extract.Status != "error" {
					t.Fatalf("extract=%+v", extract)
				}
				if findNode(t, trace, "cache", "answer").Parent != extract.ID {
					t.Fatal("answer cache outside extraction")
				}
			}
			nodes := trace.Nodes()
			if nodes[len(nodes)-1].Kind != "result" || nodes[len(nodes)-1].Parent != 1 {
				t.Fatalf("last=%+v", nodes[len(nodes)-1])
			}
		})
	}
}

func TestFetchStoppedDuringExtractionDoesNotFallBack(t *testing.T) {
	cfg := config.Default()
	cfg.Fetch.PassthroughLength = 3
	cfg.Fetch.Extract.Models = []string{"missing"}
	cfg.Fetch.Extract.RawOnFailure = true
	s := NewService(core.NewLimits())
	target := "https://example.test/page"
	s.pages.Set(target, Page{Engine: "jina", Content: "long text", Title: "fake"}, time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	trace := core.NewTrace()
	result := s.Run(core.WithTrace(ctx, trace), Runtime{Config: cfg}, Args{URL: target, Prompt: "question", Engine: EngineAuto})
	if result.Error == "" || result.Text != "" || result.Warning != "" {
		t.Fatalf("result=%+v", result)
	}
	if extract := findNode(t, trace, "extract", ""); extract.Attrs["fallback"] != nil {
		t.Fatalf("extract=%+v", extract)
	}
}

func TestFetchRouteNodes(t *testing.T) {
	for _, mode := range []string{"auto", "pinned", "rule"} {
		t.Run(mode, func(t *testing.T) {
			cfg := config.Default()
			cfg.Fetch.Routes = []config.Route{{Provider: "jina", Enabled: true}, {Provider: "exa", Enabled: false}, {Provider: "firecrawl", Enabled: true}, {Provider: "local", Enabled: true}}
			cfg.Providers["jina"].APIKey = "fake"
			cfg.Providers["exa"].APIKey = "fake"
			cfg.Fetchers = []config.Fetcher{{ID: "local", Type: config.FetcherOpenCLI, Workers: []config.Worker{{ID: "offline", Enabled: true}}}}
			target := "https://example.test/page"
			engine := EngineAuto
			if mode == "pinned" {
				engine = "jina"
			}
			if mode == "rule" {
				cfg.Routing.Rules = []config.Rule{{Name: "test rule", Enabled: true, Match: []string{"example.test/page"}, Providers: []string{"exa", "firecrawl", "local"}}}
			}
			trace := core.NewTrace()
			s := NewService(core.NewLimits())
			cachedEngine := "exa"
			if mode == "pinned" {
				cachedEngine = "jina"
			}
			s.pages.Set(target, Page{Engine: cachedEngine, Content: "cached"}, time.Minute)
			result := s.Run(core.WithTrace(context.Background(), trace), Runtime{Config: cfg}, Args{URL: target, Raw: true, Engine: engine})
			if result.Text != "cached" {
				t.Fatalf("result=%+v", result)
			}
			route := findNode(t, trace, "route", "")
			if route.Attrs["mode"] != mode {
				t.Fatalf("route=%+v", route)
			}
			var candidates []core.Candidate
			b, _ := json.Marshal(route.Attrs["candidates"])
			_ = json.Unmarshal(b, &candidates)
			want := map[string]string{"jina": "", "exa": "disabled", "firecrawl": "no_credentials", "local": "offline"}
			if mode == "pinned" {
				want = map[string]string{"jina": "", "exa": "not_pinned", "firecrawl": "not_pinned", "local": "not_pinned"}
			}
			if mode == "rule" {
				want = map[string]string{"exa": "", "firecrawl": "no_credentials", "local": "offline", "jina": "not_in_rule"}
				if candidates[0].Provider != "exa" {
					t.Fatalf("try order=%+v", candidates)
				}
				if route.Attrs["rule"].(map[string]any)["pattern"] != "example.test/page" {
					t.Fatal("missing matched pattern")
				}
			}
			if len(candidates) != len(want) {
				t.Fatalf("candidates=%+v", candidates)
			}
			for _, c := range candidates {
				if c.Reason != want[c.Provider] || c.Eligible != (c.Reason == "") {
					t.Fatalf("candidate=%+v want=%s", c, want[c.Provider])
				}
			}
		})
	}
}

func TestFetchCacheReasons(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"data":{"content":"fresh"}}`)) }))
	defer upstream.Close()
	for _, tc := range []struct {
		name                         string
		cached, rendered, noCache    bool
		cachedEngine, engine, reason string
	}{
		{name: "miss", engine: EngineAuto, reason: "miss"},
		{name: "bypass", cached: true, noCache: true, cachedEngine: "jina", engine: EngineAuto, reason: "bypassed"},
		{name: "other provider", cached: true, cachedEngine: "exa", engine: "jina", reason: "other_engine"},
		{name: "rendered", cached: true, rendered: true, cachedEngine: "jina", engine: "jina", reason: "rendered"},
		{name: "used", cached: true, cachedEngine: "jina", engine: EngineAuto},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := config.Default()
			cfg.Fetch.SmartFallback = false
			cfg.Fetch.Routes = []config.Route{{Provider: "jina", Enabled: true}}
			cfg.Providers["jina"].BaseURL = upstream.URL
			service := NewService(core.NewLimits())
			target := "https://example.test/page"
			if tc.cached {
				service.pages.Set(target, Page{Engine: tc.cachedEngine, Content: "cached", Rendered: tc.rendered}, time.Minute)
			}
			trace := core.NewTrace()
			result := service.Run(core.WithTrace(context.Background(), trace), Runtime{Config: cfg, Client: http.DefaultClient, NoCache: tc.noCache}, Args{URL: target, Raw: true, Engine: tc.engine})
			if result.Error != "" {
				t.Fatal(result.Error)
			}
			n := findNode(t, trace, "cache", "page")
			if n.Attrs["hit"] != tc.cached || (tc.reason != "" && n.Attrs["reason"] != tc.reason) || (tc.reason == "" && n.Status != "cached") {
				t.Fatalf("cache=%+v", n)
			}
		})
	}
}

func TestWorkerNodesDistinguishWorkerAndPageFailures(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fault   error
		status  string
		workers int
	}{
		{"worker fault", worker.ErrOffline, "skipped", 2},
		{"page failure", &worker.Error{Code: worker.CodeBlocked, Message: "fake page block"}, "error", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg, workers := workerSetup(t)
			workers.answer = func(id string, req worker.Request) (*worker.Page, error) {
				if id == "w1" {
					return nil, tc.fault
				}
				return readBy(id, req)
			}
			trace := core.NewTrace()
			result := NewService(core.NewLimits()).Run(core.WithTrace(context.Background(), trace), Runtime{Config: cfg, Client: http.DefaultClient, Workers: workers}, Args{URL: "https://x.com/a/status/1", Raw: true, Engine: EngineAuto})
			if (result.Error != "") != (tc.status == "error") {
				t.Fatalf("result=%+v", result)
			}
			var nodes []core.Node
			all := trace.Nodes()
			for _, n := range all {
				if n.Kind == "worker" {
					nodes = append(nodes, n)
					if n.Parent < 1 || all[n.Parent-1].Kind != "attempt" {
						t.Fatalf("worker parent=%+v", n)
					}
				}
			}
			if len(nodes) != tc.workers || nodes[0].Status != tc.status || nodes[0].Error == "" || nodes[0].Attrs["profile"] != "p1" || nodes[0].Attrs["adapter"] != true {
				t.Fatalf("worker nodes=%+v", nodes)
			}
		})
	}
}

func TestFetchCachedRouteWithNoEligibleProvidersIsNotError(t *testing.T) {
	cfg := config.Default()
	cfg.Fetch.Routes = []config.Route{{Provider: "jina", Enabled: false}, {Provider: "firecrawl", Enabled: true}}
	s := NewService(core.NewLimits())
	target := "https://example.test/cached"
	s.pages.Set(target, Page{Engine: "jina", Content: "cached content", Title: "Cached"}, time.Minute)
	trace := core.NewTrace()
	result := s.Run(core.WithTrace(context.Background(), trace), Runtime{Config: cfg}, Args{URL: target, Raw: true, Engine: EngineAuto})
	if result.Error != "" || result.Text != "cached content" {
		t.Fatalf("result=%+v", result)
	}
	route := findNode(t, trace, "route", "")
	if route.Status == "error" || route.Status != "cached" || route.Attrs["cached"] != true {
		t.Fatalf("route=%+v", route)
	}
}
