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
	"github.com/fl0w1nd/seekmux/internal/core"
)

func TestDevArgs(t *testing.T) {
	cfg := config.Default()
	args := DevArgs{Query: " q ", Repos: []string{"https://github.com/Owner/Repo.git", "Owner/Repo", " a/b/issues/1 "}, Types: []string{"issue", "issue"}}
	if err := args.Validate(cfg); err == nil {
		t.Fatal("without a key the tool is not available")
	}
	cfg.Providers["firecrawl"].APIKey = "key"
	if !DevAvailable(cfg) {
		t.Fatal("not available with a key")
	}
	if err := args.Validate(cfg); err != nil {
		t.Fatal(err)
	}
	if args.Query != "q" || args.MaxResults != DefaultMaxResults || strings.Join(args.Repos, ",") != "Owner/Repo,a/b" || strings.Join(args.Types, ",") != "issue" {
		t.Fatalf("args = %+v", args)
	}

	for name, bad := range map[string]DevArgs{
		"empty query":     {Query: " "},
		"too many":        {Query: "q", MaxResults: DevMaxResults + 1},
		"unknown type":    {Query: "q", Types: []string{"code"}},
		"not a repo":      {Query: "q", Repos: []string{"just-a-name"}},
		"repos with docs": {Query: "q", Repos: []string{"a/b"}, Types: []string{"doc"}},
	} {
		if err := bad.Validate(cfg); err == nil {
			t.Errorf("%s must be rejected", name)
		}
	}
}

func TestFirecrawlDevSearch(t *testing.T) {
	var path string
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = w.Write([]byte(`{"success": true, "partial": false, "results": [
			{"id": "pull_request:o/r#7", "url": "https://github.com/o/r/pull/7", "title": "o/r#7",
				"passages": [{"text": " first \n", "truncated": true}, {"text": ""}], "license": "MIT"},
			{"id": "doc:https://example.com/a", "type": "doc", "url": "https://example.com/a"}
		]}`))
	}))
	defer server.Close()

	cfg := config.Default()
	cfg.Providers["firecrawl"].APIKey = "key"
	cfg.Providers["firecrawl"].BaseURL = server.URL
	cfg.DevSearch.Routes[0].Options = map[string]any{"passages": 3.0}
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}

	args := DevArgs{Query: "q", MaxResults: 7, Types: []string{"pull_request"}, Repos: []string{"o/r"}}
	if err := args.Validate(cfg); err != nil {
		t.Fatal(err)
	}
	got := RunDev(context.Background(), cfg, server.Client(), core.NewLimits(), args)

	if want := map[string]any{"query": "q", "k": 7.0, "passages": 3.0, "types": []any{"pull_request"}, "repos": []any{"o/r"}}; path != "/v2/search/developer" || !reflect.DeepEqual(body, want) {
		t.Errorf("request = %s %v", path, body)
	}
	want := DevResult{Engine: "firecrawl", Query: "q", Results: []DevItem{
		{Type: "pull_request", Title: "o/r#7", URL: "https://github.com/o/r/pull/7", Passages: []string{"first"}},
		{Type: "doc", URL: "https://example.com/a"},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("result = %+v", got)
	}
}
