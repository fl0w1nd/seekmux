package fetch

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
)

func TestAMissingPageIsSettledByTwoProvidersAndRemembered(t *testing.T) {
	var calls atomic.Int32
	stub := func(reply string) *httptest.Server {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			_, _ = w.Write([]byte(reply))
		}))
		t.Cleanup(server.Close)
		return server
	}
	replies := map[string]string{
		"jina":      `{"data":{"httpStatus":404,"content":"Not Found"}}`,
		"firecrawl": `{"data":{"markdown":"Not Found","metadata":{"statusCode":404}}}`,
		"tavily":    `{"results":[{"raw_content":"an old copy"}]}`,
		"exa":       `{"results":[{"text":"an old copy"}]}`,
	}
	cfg := config.Default()
	cfg.Fetch.SmartFallback = false
	for name, reply := range replies {
		cfg.Providers[name].APIKey = "key"
		cfg.Providers[name].BaseURL = stub(reply).URL
	}
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}

	service := NewService(core.NewLimits())
	rt := Runtime{Config: cfg, Client: http.DefaultClient}
	args := Args{URL: "https://example.com/missing", Raw: true, Engine: EngineAuto}

	result := service.Run(context.Background(), rt, args)
	if !strings.HasPrefix(result.Error, "The page does not exist: the site answered 404 Not Found to jina and firecrawl.") || calls.Load() != 2 {
		t.Fatalf("error = %q after %d calls", result.Error, calls.Load())
	}

	trace := core.NewTrace()
	again := service.Run(core.WithTrace(context.Background(), trace), rt, args)
	if again.Error != result.Error || calls.Load() != 2 {
		t.Fatalf("error = %q after %d calls", again.Error, calls.Load())
	}
	for _, a := range trace.Attempts() {
		if a.Status != core.AttemptCached {
			t.Fatalf("attempts = %+v", trace.Attempts())
		}
	}

	// A provider asked for by name gets to try all the same.
	args.Engine = "tavily"
	if named := service.Run(context.Background(), rt, args); named.Error != "" || named.Content != "an old copy" {
		t.Fatalf("named = %+v", named)
	}
}
