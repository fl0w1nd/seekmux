package fetch

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
)

// routedSetup stubs every fetch provider and counts the calls each receives.
func routedSetup(t *testing.T, tavily http.HandlerFunc) (*config.Config, func() map[string]int) {
	var mu sync.Mutex
	calls := map[string]int{}
	replies := map[string]http.HandlerFunc{
		"jina": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"data":{"content":"the page shell"}}`))
		},
		"firecrawl": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"data":{"markdown":"the page shell"}}`))
		},
		"exa": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"results":[{"text":"the page shell"}]}`))
		},
		"tavily": tavily,
	}
	cfg := config.Default()
	for name, reply := range replies {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			calls[name]++
			mu.Unlock()
			reply(w, r)
		}))
		t.Cleanup(server.Close)
		cfg.Providers[name].APIKey = "key"
		cfg.Providers[name].BaseURL = server.URL
	}
	cfg.Routing.Builtin = map[string]config.BuiltinRule{"youtube": {Enabled: true}}
	// Tavily is kept for the pages only it reads.
	for i := range cfg.Fetch.Routes {
		cfg.Fetch.Routes[i].Enabled = cfg.Fetch.Routes[i].Provider != "tavily"
	}
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	return cfg, func() map[string]int {
		mu.Lock()
		defer mu.Unlock()
		out := map[string]int{}
		for name, n := range calls {
			out[name] = n
		}
		return out
	}
}

func reply(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) }
}

const video = "https://www.youtube.com/watch?v=aircAruvnKk"

func TestAVideoIsReadThroughTheProviderOfItsRuleAlone(t *testing.T) {
	cfg, calls := routedSetup(t, reply(`{"results":[{"title":"A video","raw_content":"# A video\n### Description\nabout\n### Transcript\n[0:04] This is a 3."}]}`))
	service := NewService(core.NewLimits())
	var seen []Observation
	service.Observe = func(o Observation) { seen = append(seen, o) }
	rt := Runtime{Config: cfg, Client: http.DefaultClient}

	result := service.Run(context.Background(), rt, Args{URL: video, Raw: true, Engine: EngineAuto})
	if result.Error != "" || result.Engine != "tavily" || result.Warning != "" || !strings.Contains(result.Content, "[0:04] This is a 3.") {
		t.Fatalf("result = %+v", result)
	}
	if got := calls(); len(got) != 1 || got["tavily"] != 1 {
		t.Fatalf("calls = %v", got)
	}
	if len(seen) != 1 || seen[0].Domain != "youtube.com" || seen[0].Provider != "tavily" || seen[0].Outcome != OutcomeOK || seen[0].Bytes == 0 {
		t.Fatalf("observations = %+v", seen)
	}

	// A provider asked for by name reads the page all the same, and the
	// caller learns what it cannot give.
	named := service.Run(context.Background(), rt, Args{URL: video, Raw: true, Engine: "firecrawl"})
	if named.Engine != "firecrawl" || !strings.Contains(named.Warning, "Firecrawl does not return the transcript") {
		t.Fatalf("named = %+v", named)
	}
	// Its copy must not answer the next call that leaves the choice open.
	again := service.Run(context.Background(), rt, Args{URL: video, Raw: true, Engine: EngineAuto})
	if again.Engine != "tavily" || again.Warning != "" {
		t.Fatalf("again = %+v", again)
	}

	// Any other page goes down the fetch routes, where Tavily is switched off.
	other := service.Run(context.Background(), rt, Args{URL: "https://www.youtube.com/@3blue1brown", Raw: true, Engine: EngineAuto})
	if other.Engine != "jina" {
		t.Fatalf("other = %+v", other)
	}
}

func TestAVideoWithoutCaptionsIsToldApartFromAProviderThatFailed(t *testing.T) {
	const url = "https://youtu.be/jfKfPfyJRdk"

	cfg, _ := routedSetup(t, reply(`{"results":[{"raw_content":"# lofi radio\n### Description\nbeats"}]}`))
	rt := Runtime{Config: cfg, Client: http.DefaultClient}
	got := NewService(core.NewLimits()).Run(context.Background(), rt, Args{URL: url, Raw: true, Engine: EngineAuto})
	if got.Error != "" || !strings.Contains(got.Warning, "returned no transcript") || !strings.Contains(got.Content, "lofi radio") {
		t.Errorf("no captions: %+v", got)
	}

	// Tavily reached the site and says what it found.
	cfg, _ = routedSetup(t, reply(`{"results":[],"failed_results":[{"error":"Failed to fetch url"}]}`))
	rt.Config = cfg
	got = NewService(core.NewLimits()).Run(context.Background(), rt, Args{URL: url, Raw: true, Engine: EngineAuto})
	if got.Error != "Tavily could not get the page: Failed to fetch url" {
		t.Errorf("unreachable video: %+v", got)
	}

	// Tavily itself is out: the page was never asked for, and nobody else is.
	cfg, calls := routedSetup(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(432)
		_, _ = w.Write([]byte(`{"detail":"plan limit"}`))
	})
	rt.Config = cfg
	var seen []Observation
	service := NewService(core.NewLimits())
	service.Observe = func(o Observation) { seen = append(seen, o) }
	got = service.Run(context.Background(), rt, Args{URL: url, Raw: true, Engine: EngineAuto})
	if !strings.HasPrefix(got.Error, "YouTube pages are read through Tavily only, and that failed: Tavily API error: 432") ||
		!strings.HasSuffix(got.Error, "No other provider was tried.") {
		t.Errorf("provider out: %+v", got)
	}
	if n := calls(); n["jina"]+n["firecrawl"]+n["exa"] != 0 {
		t.Errorf("calls = %v", n)
	}
	if len(seen) != 0 {
		t.Errorf("a provider's own failure says nothing about the domain: %+v", seen)
	}

	cfg.Providers["tavily"].APIKey = ""
	got = NewService(core.NewLimits()).Run(context.Background(), rt, Args{URL: url, Raw: true, Engine: EngineAuto})
	if got.Error != "YouTube pages are read through Tavily only, and that failed: no API key is configured. No other provider was tried." {
		t.Errorf("no key: %+v", got)
	}
}

func TestOutcomesAndDomains(t *testing.T) {
	for url, want := range map[string]string{
		"https://m.youtube.com/watch?v=1":   "youtube.com",
		"https://news.bbc.co.uk/a":          "bbc.co.uk",
		"http://127.0.0.1:8080/x":           "127.0.0.1",
		"https://user.github.io/project":    "user.github.io",
		"https://intranet/x":                "intranet",
		"https://Docs.Example.COM./a?b=c#d": "example.com",
	} {
		if got := Domain(url); got != want {
			t.Errorf("Domain(%q) = %q, want %q", url, got, want)
		}
	}
	for want, err := range map[string]error{
		OutcomeBlocked: siteError("Jina", 403),
		OutcomeMissing: siteError("Jina", 404),
		OutcomeFailed:  &core.TargetError{Provider: "Tavily", Reason: "Failed to fetch url"},
		OutcomeTimeout: context.DeadlineExceeded,
		"":             context.Canceled,
	} {
		if got := outcome(err); got != want {
			t.Errorf("outcome(%v) = %q, want %q", err, got, want)
		}
	}
	if got := outcome(&core.HTTPError{StatusCode: 429}); got != "" {
		t.Errorf("a provider's rate limit = %q", got)
	}
	if got := outcome(&core.HTTPError{StatusCode: 500, Class: core.ClassTarget}); got != OutcomeFailed {
		t.Errorf("a scrape failure = %q", got)
	}
}
