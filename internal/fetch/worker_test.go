package fetch

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/worker"
)

// asked is one fetch a stub worker was handed.
type asked struct {
	worker string
	req    worker.Request
}

// stubWorkers answer fetches as the test says, by worker id, and record what
// they were asked.
type stubWorkers struct {
	mu       sync.Mutex
	offline  map[string]bool
	requests []asked
	answer   func(id string, req worker.Request) (*worker.Page, error)
}

func (w *stubWorkers) Online(id string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return !w.offline[id]
}

func (w *stubWorkers) Fetch(_ context.Context, id string, req worker.Request) (*worker.Page, error) {
	w.mu.Lock()
	w.requests = append(w.requests, asked{id, req})
	offline := w.offline[id]
	w.mu.Unlock()
	if offline {
		return nil, worker.ErrOffline
	}
	return w.answer(id, req)
}

func (w *stubWorkers) asked() []asked {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := w.requests
	w.requests = nil
	return out
}

func readBy(id string, req worker.Request) (*worker.Page, error) {
	return &worker.Page{URL: req.URL, Title: "T", Content: "read by " + id, Source: "page"}, nil
}

// workerSetup has a failing Jina ahead of the fetcher "home" on the fetch
// routes, and the X rule sending its pages to the fetcher alone. The fetcher
// has three workers: w1 and w2 switched on, w0 ahead of them switched off.
func workerSetup(t *testing.T) (*config.Config, *stubWorkers) {
	cfg, _ := routedSetup(t, reply(`{}`))
	cfg.Fetchers = []config.Fetcher{{
		ID: "home", Type: config.FetcherOpenCLI, Name: "Home",
		Workers: []config.Worker{
			{ID: "w0", Name: "Old", Token: "t0"},
			{ID: "w1", Name: "Laptop", Enabled: true, Token: "t1", Profile: "p1"},
			{ID: "w2", Name: "Desktop", Enabled: true, Token: "t2", Profile: "p2"},
		},
	}}
	cfg.Routing.Builtin = map[string]config.BuiltinRule{"twitter": {Enabled: true, Providers: []string{"home"}}}
	cfg.Normalize()
	for i, route := range cfg.Fetch.Routes {
		cfg.Fetch.Routes[i].Enabled = route.Provider == "jina" || route.Provider == "home"
	}
	cfg.Providers["jina"].BaseURL = "http://127.0.0.1:1"
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	return cfg, &stubWorkers{offline: map[string]bool{}, answer: readBy}
}

func run(t *testing.T, service *Service, rt Runtime, url, engine string) Result {
	t.Helper()
	return service.Run(context.Background(), rt, Args{URL: url, Raw: true, Engine: engine})
}

func TestTheWorkerUsesAdaptersOnlyForRoutedPages(t *testing.T) {
	cfg, w := workerSetup(t)
	service := NewService(core.NewLimits())
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Workers: w}

	if got := run(t, service, rt, "https://x.com/a/status/1", EngineAuto); got.Error != "" || got.Engine != "home" {
		t.Fatalf("routed = %+v", got)
	}
	// Jina fails on an ordinary page and the fetcher takes over, reading it whole.
	if got := run(t, service, rt, "https://example.com/a", EngineAuto); got.Error != "" || got.Engine != "home" {
		t.Fatalf("plain = %+v", got)
	}
	got := w.asked()
	if len(got) != 2 || got[0].worker != "w1" || !got[0].req.Adapter || got[1].req.Adapter || got[0].req.Profile != "p1" {
		t.Fatalf("asked = %+v", got)
	}
}

func TestAFetcherWithoutAWorkerOnlineIsSkipped(t *testing.T) {
	cfg, w := workerSetup(t)
	w.offline = map[string]bool{"w0": false, "w1": true, "w2": true}
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Workers: w}
	got := run(t, NewService(core.NewLimits()), rt, "https://x.com/a/status/1", EngineAuto)
	if !strings.Contains(got.Error, "no worker of the fetcher is online") {
		t.Fatalf("got = %+v", got)
	}
	if asked := w.asked(); len(asked) != 0 {
		t.Fatalf("an offline fetcher was asked: %+v", asked)
	}
	// It stays a choice of the tool, so the schema does not change as its
	// workers come and go.
	if engines := Engines(cfg); !strings.Contains(strings.Join(engines, " "), "home") {
		t.Fatalf("engines = %v", engines)
	}
}

// A worker that cannot take the page hands it to the next one, in their
// order; a worker switched off is never asked.
func TestWorkersTakeAPageInTheirOrder(t *testing.T) {
	for _, fault := range []error{
		worker.ErrOffline,
		worker.ErrDisconnected,
		errors.New("write: broken pipe"),
		&worker.Error{Code: worker.CodeBusy, Message: "the worker is already running 1 fetches"},
		&worker.Error{Code: worker.CodeBrowserUnavailable, Message: "Browser Bridge is not connected"},
		&worker.Error{Code: worker.CodeProfileMissing, Message: `no profile "p1"`},
		&worker.Error{Code: worker.CodeInternal, Message: "could not start OpenCLI"},
	} {
		cfg, w := workerSetup(t)
		w.answer = func(id string, req worker.Request) (*worker.Page, error) {
			if id == "w1" {
				return nil, fault
			}
			return readBy(id, req)
		}
		rt := Runtime{Config: cfg, Client: http.DefaultClient, Workers: w, NoCache: true}
		got := run(t, NewService(core.NewLimits()), rt, "https://x.com/a/status/1", EngineAuto)
		if got.Error != "" || !strings.Contains(got.Text, "read by w2") {
			t.Fatalf("%v: got = %+v", fault, got)
		}
		asked := w.asked()
		if len(asked) != 2 || asked[0].worker != "w1" || asked[1].worker != "w2" || asked[1].req.Profile != "p2" || !asked[1].req.Adapter {
			t.Fatalf("%v: asked = %+v", fault, asked)
		}
	}
}

// A page the worker could not read ends the fetcher's attempt: the next
// worker is not asked, the next provider is, and the breaker is not tripped.
func TestAPageFailureIsNotHandedToTheNextWorker(t *testing.T) {
	cfg, w := workerSetup(t)
	limits := core.NewLimits()
	limits.Breaker.Configure(core.BreakerSettings{Enabled: true, Failures: 3, Window: time.Minute, Cooldown: time.Minute})
	service := NewService(limits)
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Workers: w, NoCache: true}

	for _, failure := range []struct {
		code, says string
	}{
		{worker.CodeLoginRequired, "not signed in to the site: Not logged in to x.com"},
		{worker.CodeNotFound, "Not logged in to x.com"},
		{worker.CodeBlocked, "Not logged in to x.com"},
		{worker.CodeTimeout, "Not logged in to x.com"},
		{worker.CodeEmpty, "Not logged in to x.com"},
		{worker.CodeFailed, "Not logged in to x.com"},
	} {
		w.answer = func(string, worker.Request) (*worker.Page, error) {
			return nil, &worker.Error{Code: failure.code, Message: "Not logged in to x.com"}
		}
		for range 4 {
			got := run(t, service, rt, "https://x.com/a/status/1", EngineAuto)
			if !strings.Contains(got.Error, failure.says) {
				t.Fatalf("%s: got = %+v", failure.code, got)
			}
		}
		for _, a := range w.asked() {
			if a.worker != "w1" {
				t.Fatalf("%s: %s was asked", failure.code, a.worker)
			}
		}
		if _, off := limits.Breaker.State("home:" + config.ToolFetch); off {
			t.Fatalf("%s: pages that fail must not trip the breaker", failure.code)
		}
	}
}

// When no worker can take the page, the fetcher is unavailable for the run:
// each worker is asked once, and the run does not wait for its deadline.
func TestAFetcherWhoseWorkersAllFailIsNotRetried(t *testing.T) {
	cfg, w := workerSetup(t)
	service := NewService(core.NewLimits())
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Workers: w, NoCache: true}
	w.answer = func(id string, _ worker.Request) (*worker.Page, error) {
		if id == "w1" {
			return nil, worker.ErrDisconnected
		}
		return nil, &worker.Error{Code: worker.CodeBusy, Message: "the worker is already running 1 fetches"}
	}
	started := time.Now()
	got := run(t, service, rt, "https://x.com/a/status/1", EngineAuto)
	if !strings.Contains(got.Error, "Home is unavailable") || !strings.Contains(got.Error, "Laptop: ") || !strings.Contains(got.Error, "Desktop: busy") || time.Since(started) > 2*time.Second {
		t.Fatalf("got = %+v after %v", got, time.Since(started))
	}
	if asked := w.asked(); len(asked) != 2 {
		t.Fatalf("asked = %+v", asked)
	}
}

// Whether a provider races is a setting of its fetch route.
func TestARouteCanKeepItsProviderOutOfTheRace(t *testing.T) {
	cfg, w := workerSetup(t)
	for i, route := range cfg.Fetch.Routes {
		cfg.Fetch.Routes[i].NoHedge = route.Provider == "home"
	}
	providers := Providers(cfg, http.DefaultClient, w)
	if len(providers) != len(cfg.Fetch.Routes) {
		t.Fatalf("%d providers for %d routes", len(providers), len(cfg.Fetch.Routes))
	}
	for _, p := range providers {
		if p.NoHedge != (p.Name == "home") {
			t.Fatalf("%s: NoHedge = %v", p.Name, p.NoHedge)
		}
	}
}

// A page a worker read as rendered, as a fallback, does not answer a call
// that names the fetcher and so asks for its site adapter.
func TestARenderedPageDoesNotAnswerForTheAdapter(t *testing.T) {
	cfg, w := workerSetup(t)
	cfg.Routing.Builtin = nil
	service := NewService(core.NewLimits())
	rt := Runtime{Config: cfg, Client: http.DefaultClient, Workers: w}
	url := "https://x.com/a/status/1"

	if got := run(t, service, rt, url, EngineAuto); got.Error != "" {
		t.Fatalf("fallback: %+v", got)
	}
	if got := run(t, service, rt, url, "home"); got.Error != "" {
		t.Fatalf("named: %+v", got)
	}
	// And the adapter's page answers a fallback after it.
	if got := run(t, service, rt, url, EngineAuto); got.Error != "" {
		t.Fatalf("fallback again: %+v", got)
	}
	if asked := w.asked(); len(asked) != 2 || asked[0].req.Adapter || !asked[1].req.Adapter {
		t.Fatalf("asked = %+v", asked)
	}
}
