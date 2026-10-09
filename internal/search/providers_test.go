package search

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/fl0w1nd/seekmux/internal/config"
)

// capture runs one search through the named provider against a stub and
// returns the request the provider sent.
func capture(t *testing.T, provider string, edit func(*config.Config, *config.Route), in Input) (query map[string]string, body map[string]any) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = map[string]string{}
		for key := range r.URL.Query() {
			query[key] = r.URL.Query().Get(key)
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	cfg := config.Default()
	cfg.Providers[provider].APIKey = "key"
	cfg.Providers[provider].BaseURL = server.URL
	for i := range cfg.Search.Routes {
		if route := &cfg.Search.Routes[i]; route.Provider == provider && edit != nil {
			edit(cfg, route)
		}
	}
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, p := range Providers(cfg, server.Client()) {
		if p.Name == provider {
			if _, err := p.Execute(context.Background(), in); err != nil {
				t.Fatal(err)
			}
		}
	}
	return query, body
}

func TestDefaultRequests(t *testing.T) {
	in := Input{Query: "q", MaxResults: 5, TimeRange: "week"}

	query, _ := capture(t, "brave", nil, in)
	if want := map[string]string{"q": "q", "count": "5", "freshness": "pw"}; !reflect.DeepEqual(query, want) {
		t.Errorf("brave query = %v", query)
	}

	_, body := capture(t, "exa", nil, in)
	delete(body, "startPublishedDate")
	want := map[string]any{"query": "q", "numResults": 5.0, "type": "auto", "contents": map[string]any{"highlights": map[string]any{"maxCharacters": 600.0}}}
	if !reflect.DeepEqual(body, want) {
		t.Errorf("exa body = %v", body)
	}

	_, body = capture(t, "tavily", nil, in)
	want = map[string]any{"query": "q", "search_depth": "advanced", "max_results": 5.0, "time_range": "week", "include_published_date": true}
	if !reflect.DeepEqual(body, want) {
		t.Errorf("tavily body = %v", body)
	}

	_, body = capture(t, "perplexity", nil, in)
	want = map[string]any{"query": "q", "max_results": 5.0, "max_tokens_per_page": 256.0, "search_recency_filter": "week"}
	if !reflect.DeepEqual(body, want) {
		t.Errorf("perplexity body = %v", body)
	}
}

func TestOptionsReachTheRequest(t *testing.T) {
	in := Input{Query: "q", MaxResults: 5, IncludeDomains: []string{"a.com", "b.org"}, ExcludeDomains: []string{"c.net"}}
	global := func(cfg *config.Config) { cfg.Search.Country, cfg.Search.Language = "JP", "ja" }

	query, _ := capture(t, "brave", func(cfg *config.Config, r *config.Route) {
		global(cfg)
		r.Options = map[string]any{"extra_snippets": true, "safesearch": "off", "language": "zh"}
		r.ExtraBody = map[string]any{"result_filter": "web", "safesearch": "strict"}
	}, in)
	want := map[string]string{
		"q": "q (site:a.com OR site:b.org) -site:c.net", "count": "5", "country": "JP", "search_lang": "zh-hans",
		"extra_snippets": "true", "safesearch": "strict", "result_filter": "web",
	}
	if !reflect.DeepEqual(query, want) {
		t.Errorf("brave query = %v", query)
	}

	_, body := capture(t, "exa", func(cfg *config.Config, r *config.Route) {
		global(cfg)
		r.Options = map[string]any{"type": "fast", "contents": "summary", "max_age_hours": 0.0}
	}, in)
	if body["type"] != "fast" || body["userLocation"] != "JP" || !reflect.DeepEqual(body["contents"], map[string]any{"summary": map[string]any{}, "maxAgeHours": 0.0}) ||
		!reflect.DeepEqual(body["includeDomains"], []any{"a.com", "b.org"}) || !reflect.DeepEqual(body["excludeDomains"], []any{"c.net"}) {
		t.Errorf("exa body = %v", body)
	}

	_, body = capture(t, "tavily", func(cfg *config.Config, r *config.Route) {
		global(cfg)
		r.Options = map[string]any{"search_depth": "basic", "chunks_per_source": 1.0, "country": "DE"}
	}, in)
	if body["search_depth"] != "basic" || body["chunks_per_source"] != 1.0 || body["country"] != "germany" || body["language"] != "ja" ||
		!reflect.DeepEqual(body["include_domains"], []any{"a.com", "b.org"}) {
		t.Errorf("tavily body = %v", body)
	}

	_, body = capture(t, "perplexity", func(cfg *config.Config, r *config.Route) {
		global(cfg)
		r.Options = map[string]any{"search_type": "fast", "max_tokens_per_page": 128.0, "max_tokens": 2000.0}
	}, in)
	if body["search_type"] != "fast" || body["max_tokens_per_page"] != 128.0 || body["max_tokens"] != 2000.0 || body["country"] != "JP" ||
		!reflect.DeepEqual(body["search_language_filter"], []any{"ja"}) || !reflect.DeepEqual(body["search_domain_filter"], []any{"a.com", "b.org"}) {
		t.Errorf("perplexity body = %v", body)
	}

	_, body = capture(t, "perplexity", nil, Input{Query: "q", MaxResults: 5, ExcludeDomains: []string{"c.net"}})
	if !reflect.DeepEqual(body["search_domain_filter"], []any{"-c.net"}) {
		t.Errorf("perplexity denylist = %v", body["search_domain_filter"])
	}
}

func TestDomainFilters(t *testing.T) {
	cfg := config.Default()
	args := Args{Queries: []string{"q"}, IncludeDomains: []string{" https://www.Example.com/docs ", "example.com", ""}, ExcludeDomains: []string{"blog.example.com"}}
	if err := args.Validate(cfg); err != nil {
		t.Fatal(err)
	}
	if strings.Join(args.IncludeDomains, ",") != "example.com" {
		t.Fatalf("include = %v", args.IncludeDomains)
	}

	items := filterDomains([]Item{
		{URL: "https://example.com/a"}, {URL: "https://docs.example.com/b"},
		{URL: "https://blog.example.com/c"}, {URL: "https://notexample.com/d"},
	}, args)
	if len(items) != 2 || items[0].URL != "https://example.com/a" || items[1].URL != "https://docs.example.com/b" {
		t.Fatalf("filtered = %v", items)
	}

	for _, bad := range [][]string{{"not a domain"}, {"localhost"}, strings.Split("a.co,b.co,c.co,d.co,e.co,f.co,g.co,h.co,i.co,j.co,k.co", ",")} {
		if err := (&Args{Queries: []string{"q"}, IncludeDomains: bad}).Validate(cfg); err == nil {
			t.Errorf("%v must be rejected", bad)
		}
	}
}
