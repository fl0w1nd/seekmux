package fetch

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/fl0w1nd/seekmux/internal/config"
)

// capture fetches one page through the named provider against a stub
// answering with reply, and returns the request the provider sent.
func capture(t *testing.T, provider, reply string, edit func(*config.Route), in Input) (header http.Header, body map[string]any, page Page, err error) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header = r.Header
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = w.Write([]byte(reply))
	}))
	defer server.Close()

	cfg := config.Default()
	cfg.Providers[provider].APIKey = "key"
	cfg.Providers[provider].BaseURL = server.URL
	for i := range cfg.Fetch.Routes {
		if route := &cfg.Fetch.Routes[i]; route.Provider == provider && edit != nil {
			edit(route)
		}
	}
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, p := range Providers(cfg, server.Client()) {
		if p.Name == provider {
			page, err = p.Execute(context.Background(), in)
		}
	}
	return header, body, page, err
}

func TestDefaultRequests(t *testing.T) {
	in := Input{URL: "https://example.com/a"}

	header, _, _, _ := capture(t, "jina", `{"data":{"content":"x"}}`, nil, in)
	if header.Get("X-Retain-Images") != "none" || header.Get("X-Engine") != "" || header.Get("X-Cache-Tolerance") != "" {
		t.Errorf("jina headers = %v", header)
	}

	_, body, _, _ := capture(t, "firecrawl", `{"data":{"markdown":"x"}}`, nil, in)
	if want := map[string]any{"url": in.URL, "formats": []any{"markdown"}}; !reflect.DeepEqual(body, want) {
		t.Errorf("firecrawl body = %v", body)
	}

	_, body, _, _ = capture(t, "tavily", `{"results":[{"raw_content":"x"}]}`, nil, in)
	if want := map[string]any{"urls": []any{in.URL}}; !reflect.DeepEqual(body, want) {
		t.Errorf("tavily body = %v", body)
	}

	_, body, page, err := capture(t, "exa", `{"results":[{"title":"T","url":"https://example.com/a","text":"hello"}],"statuses":[{"status":"success"}]}`, nil, in)
	want := map[string]any{"urls": []any{in.URL}, "text": map[string]any{"verbosity": "compact"}, "livecrawlTimeout": 10000.0}
	if err != nil || page.Content != "hello" || page.Title != "T" || !reflect.DeepEqual(body, want) {
		t.Errorf("exa: page = %+v, err = %v, body = %v", page, err, body)
	}
}

func TestOptionsReachTheRequest(t *testing.T) {
	in := Input{URL: "https://example.com/a"}

	header, _, _, _ := capture(t, "jina", `{"data":{"content":"x"}}`, func(r *config.Route) {
		r.Options = map[string]any{"engine": "browser", "retain_images": "all", "cache_tolerance_seconds": 0.0, "proxy_country": "us"}
		r.ExtraBody = map[string]any{"X-Timeout": 30.0}
	}, in)
	if header.Get("X-Engine") != "browser" || header.Get("X-Retain-Images") != "" || header.Get("X-Cache-Tolerance") != "0" ||
		header.Get("X-Proxy") != "us" || header.Get("X-Timeout") != "30" {
		t.Errorf("jina headers = %v", header)
	}

	_, body, _, _ := capture(t, "firecrawl", `{"data":{"markdown":"x"}}`, func(r *config.Route) {
		r.Options = map[string]any{"max_age_hours": 0.0, "proxy": "enhanced", "wait_for_ms": 500.0, "only_main_content": false, "pdf_max_pages": 20.0, "country": "de"}
		r.ExtraBody = map[string]any{"mobile": true}
	}, in)
	want := map[string]any{
		"url": in.URL, "formats": []any{"markdown"}, "maxAge": 0.0, "proxy": "enhanced", "waitFor": 500.0, "onlyMainContent": false,
		"location": map[string]any{"country": "DE"}, "parsers": []any{map[string]any{"type": "pdf", "maxPages": 20.0}}, "mobile": true,
	}
	if !reflect.DeepEqual(body, want) {
		t.Errorf("firecrawl body = %v", body)
	}

	_, body, _, _ = capture(t, "tavily", `{"results":[{"raw_content":"x"}]}`, func(r *config.Route) {
		r.Options = map[string]any{"extract_depth": "advanced"}
	}, in)
	if body["extract_depth"] != "advanced" {
		t.Errorf("tavily body = %v", body)
	}
}

func TestExaReportsAFailedPage(t *testing.T) {
	in := Input{URL: "https://example.com/missing"}
	_, _, _, err := capture(t, "exa", `{"results":[],"statuses":[{"status":"error","error":{"tag":"CRAWL_NOT_FOUND","httpStatusCode":404}}]}`, nil, in)
	if err == nil || err.Error() != "Exa could not get the page: the site answered 404 Not Found" {
		t.Fatalf("err = %v", err)
	}
	_, _, _, err = capture(t, "exa", `{"results":[],"statuses":[{"status":"error","error":{"tag":"CRAWL_LIVECRAWL_TIMEOUT"}}]}`, nil, in)
	if err == nil || err.Error() != "Exa could not get the page: CRAWL_LIVECRAWL_TIMEOUT" {
		t.Fatalf("err = %v", err)
	}
}
