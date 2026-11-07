package fetch

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/worker"
)

// stubWorker answers fetches as the test says and records what it was asked.
type stubWorker struct {
	mu       sync.Mutex
	online   bool
	requests []worker.Request
	answer   func(worker.Request) (*worker.Page, error)
}

func (w *stubWorker) Online() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.online
}

func (w *stubWorker) Fetch(_ context.Context, req worker.Request) (*worker.Page, error) {
	w.mu.Lock()
	w.requests = append(w.requests, req)
	w.mu.Unlock()
	return w.answer(req)
}

// workerSetup has a failing Jina ahead of OpenCLI on the fetch routes, and
// the X rule sending its pages to OpenCLI alone.
func workerSetup(t *testing.T) (*config.Config, *stubWorker) {
	cfg, _ := routedSetup(t, reply(`{}`))
	for i, route := range cfg.Fetch.Routes {
		cfg.Fetch.Routes[i].Enabled = route.Provider == "jina" || route.Provider == config.ProviderOpenCLI
	}
	cfg.Providers["jina"].BaseURL = "http://127.0.0.1:1"
	cfg.Providers[config.ProviderOpenCLI].APIKey = "token"
	cfg.Providers[config.ProviderOpenCLI].Profile = "p1"
	cfg.Routing.Builtin = map[string]config.BuiltinRule{"twitter": {Enabled: true, Providers: []string{config.ProviderOpenCLI}}}
	w := &stubWorker{online: true, answer: func(req worker.Request) (*worker.Page, error) {
		return &worker.Page{URL: req.URL, Title: "T", Content: "read by the worker", Source: "page"}, nil
	}}
	return cfg, w
}

func TestTheWorkerUsesAdaptersOnlyForRoutedPages(t *testing.T) {
	cfg, w := workerSetup(t)
	service := NewService(core.NewLimits())
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Worker: w}

	routed := service.Run(context.Background(), rt, Args{URL: "https://x.com/a/status/1", Raw: true, Engine: EngineAuto})
	if routed.Error != "" || routed.Engine != config.ProviderOpenCLI {
		t.Fatalf("routed = %+v", routed)
	}
	// Jina fails on an ordinary page and OpenCLI takes over, reading it whole.
	plain := service.Run(context.Background(), rt, Args{URL: "https://example.com/a", Raw: true, Engine: EngineAuto})
	if plain.Error != "" || plain.Engine != config.ProviderOpenCLI {
		t.Fatalf("plain = %+v", plain)
	}
	if len(w.requests) != 2 || !w.requests[0].Adapter || w.requests[1].Adapter || w.requests[0].Profile != "p1" {
		t.Fatalf("requests = %+v", w.requests)
	}
}

func TestAnOfflineWorkerIsSkipped(t *testing.T) {
	cfg, w := workerSetup(t)
	w.online = false
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Worker: w}
	got := NewService(core.NewLimits()).Run(context.Background(), rt, Args{URL: "https://x.com/a/status/1", Raw: true, Engine: EngineAuto})
	if !strings.Contains(got.Error, "the worker is offline or cannot reach its browser") {
		t.Fatalf("got = %+v", got)
	}
	if len(w.requests) != 0 {
		t.Fatal("an offline worker must not be asked")
	}
	// It stays a choice of the tool, so the schema does not change as it
	// comes and goes.
	if engines := Engines(cfg); !strings.Contains(strings.Join(engines, " "), config.ProviderOpenCLI) {
		t.Fatalf("engines = %v", engines)
	}
}

func TestWorkerFailures(t *testing.T) {
	cfg, w := workerSetup(t)
	limits := core.NewLimits()
	limits.Breaker.Configure(core.BreakerSettings{Enabled: true, Failures: 3, Window: time.Minute, Cooldown: time.Minute})
	service := NewService(limits)
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Worker: w, NoCache: true}
	key := config.ProviderOpenCLI + ":" + config.ToolFetch

	// A page the profile cannot read moves on, and does not count against it.
	w.answer = func(worker.Request) (*worker.Page, error) {
		return nil, &worker.Error{Code: worker.CodeLoginRequired, Message: "Not logged in to x.com"}
	}
	for range 4 {
		got := service.Run(context.Background(), rt, Args{URL: "https://x.com/a/status/1", Raw: true, Engine: EngineAuto})
		if !strings.Contains(got.Error, "not signed in to the site: Not logged in to x.com") {
			t.Fatalf("got = %+v", got)
		}
	}
	if _, off := limits.Breaker.State(key); off {
		t.Fatal("pages that fail must not trip the breaker")
	}

	// A profile OpenCLI does not know switches it off until fixed.
	w.answer = func(worker.Request) (*worker.Page, error) {
		return nil, &worker.Error{Code: worker.CodeProfileMissing, Message: `no profile "p1"`}
	}
	service.Run(context.Background(), rt, Args{URL: "https://x.com/a/status/1", Raw: true, Engine: EngineAuto})
	if trip, off := limits.Breaker.State(key); !off || trip.Reason != core.ClassSetup || !strings.Contains(trip.Detail, "p1") {
		t.Fatalf("trip = %+v, %v", trip, off)
	}
}

// A worker that drops off during a fetch fails that fetch at once: a page
// routed to it alone is not retried until the run times out.
func TestAWorkerThatDisconnectsIsNotRetried(t *testing.T) {
	cfg, w := workerSetup(t)
	service := NewService(core.NewLimits())
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Worker: w, NoCache: true}
	for _, err := range []error{
		worker.ErrDisconnected,
		worker.ErrOffline,
		&worker.Error{Code: worker.CodeBrowserUnavailable, Message: "Browser Bridge is not connected"},
		&worker.Error{Code: worker.CodeBusy, Message: "the worker is already running 1 fetches"},
	} {
		w.mu.Lock()
		w.requests = nil
		w.mu.Unlock()
		w.answer = func(worker.Request) (*worker.Page, error) { return nil, err }
		started := time.Now()
		got := service.Run(context.Background(), rt, Args{URL: "https://x.com/a/status/1", Raw: true, Engine: EngineAuto})
		if !strings.Contains(got.Error, "OpenCLI is unavailable") || time.Since(started) > 2*time.Second {
			t.Fatalf("%v: got = %+v after %v", err, got, time.Since(started))
		}
		if len(w.requests) != 1 {
			t.Fatalf("%v: the worker was asked %d times", err, len(w.requests))
		}
	}
}

// Whether a provider races is a setting of its fetch route.
func TestARouteCanKeepItsProviderOutOfTheRace(t *testing.T) {
	cfg, w := workerSetup(t)
	for i, route := range cfg.Fetch.Routes {
		cfg.Fetch.Routes[i].NoHedge = route.Provider == config.ProviderOpenCLI
	}
	for _, p := range Providers(cfg, http.DefaultClient, w) {
		if p.NoHedge != (p.Name == config.ProviderOpenCLI) {
			t.Fatalf("%s: NoHedge = %v", p.Name, p.NoHedge)
		}
	}
}

// A page the worker read as rendered, as a fallback, does not answer a call
// that names OpenCLI and so asks for its site adapter.
func TestARenderedPageDoesNotAnswerForTheAdapter(t *testing.T) {
	cfg, w := workerSetup(t)
	cfg.Routing.Builtin = nil
	service := NewService(core.NewLimits())
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Worker: w}
	url := "https://x.com/a/status/1"

	if got := service.Run(context.Background(), rt, Args{URL: url, Raw: true, Engine: EngineAuto}); got.Error != "" {
		t.Fatalf("fallback: %+v", got)
	}
	if got := service.Run(context.Background(), rt, Args{URL: url, Raw: true, Engine: config.ProviderOpenCLI}); got.Error != "" {
		t.Fatalf("named: %+v", got)
	}
	// And the adapter's page answers a fallback after it.
	if got := service.Run(context.Background(), rt, Args{URL: url, Raw: true, Engine: EngineAuto}); got.Error != "" {
		t.Fatalf("fallback again: %+v", got)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.requests) != 2 || w.requests[0].Adapter || !w.requests[1].Adapter {
		t.Fatalf("requests = %+v", w.requests)
	}
}
