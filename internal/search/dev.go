package search

import (
	"context"
	"fmt"
	"maps"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/upstream"
)

const (
	// DevMaxResults keeps an answer readable: a result carries whole passages
	// rather than a snippet.
	DevMaxResults = 20
	DevMaxRepos   = 10
)

// DevTypes are the kinds of result dev_search returns and the values of its
// types argument.
var DevTypes = []string{"doc", "issue", "pull_request", "readme"}

// DevArgs are the arguments of the dev_search tool.
type DevArgs struct {
	Query      string `json:"query"`
	MaxResults int    `json:"maxResults"`
	// Types restricts the results to these kinds; empty means all of them.
	Types []string `json:"types"`
	// Repos restricts issues, pull requests and READMEs to these repositories,
	// each as owner/name.
	Repos []string `json:"repos"`
}

type DevItem struct {
	Type  string `json:"type,omitempty"`
	Title string `json:"title,omitempty"`
	URL   string `json:"url,omitempty"`
	// Passages are the parts of the document that matched, as markdown.
	Passages []string `json:"passages,omitempty"`
}

// DevResult is the answer of the dev_search tool.
type DevResult struct {
	Engine  string    `json:"search_engine,omitempty"`
	Query   string    `json:"query"`
	Results []DevItem `json:"results"`
	Error   string    `json:"error,omitempty"`
}

type DevInput struct {
	Query      string
	MaxResults int
	Types      []string
	Repos      []string
}

type devExecutor func(ctx context.Context, c call, in DevInput) ([]DevItem, error)

var devExecutors = map[string]devExecutor{
	"firecrawl": firecrawlDevSearch,
}

// DevProviders builds the dev_search providers of cfg in priority order.
func DevProviders(cfg *config.Config, client *http.Client) []core.Provider[DevInput, []DevItem] {
	var out []core.Provider[DevInput, []DevItem]
	for _, route := range cfg.DevSearch.Routes {
		if run, ok := devExecutors[route.Provider]; ok {
			out = append(out, routed(cfg, config.ToolDevSearch, route, newCall(cfg, client, config.ToolDevSearch, route), run))
		}
	}
	return out
}

// DevAvailable reports whether the dev_search tool can run under cfg.
func DevAvailable(cfg *config.Config) bool {
	return slices.ContainsFunc(DevProviders(cfg, nil), func(p core.Provider[DevInput, []DevItem]) bool { return p.Available })
}

var repoPattern = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

// cleanRepos reduces each entry, which callers also write as a GitHub URL, to
// owner/name.
func cleanRepos(list []string) ([]string, error) {
	var out []string
	for _, entry := range list {
		r := strings.TrimSpace(entry)
		if _, rest, ok := strings.Cut(r, "github.com/"); ok {
			r = rest
		}
		if parts := strings.Split(strings.Trim(r, "/"), "/"); len(parts) >= 2 {
			r = parts[0] + "/" + strings.TrimSuffix(parts[1], ".git")
		}
		if r == "" {
			continue
		}
		if !repoPattern.MatchString(r) {
			return nil, fmt.Errorf("repos: %q is not a repository such as owner/name", entry)
		}
		if !slices.Contains(out, r) {
			out = append(out, r)
		}
	}
	if len(out) > DevMaxRepos {
		return nil, fmt.Errorf("repos takes at most %d repositories", DevMaxRepos)
	}
	return out, nil
}

// Validate checks args against cfg and applies the defaults.
func (a *DevArgs) Validate(cfg *config.Config) error {
	if a.Query = strings.TrimSpace(a.Query); a.Query == "" {
		return fmt.Errorf("query is required")
	}
	if a.MaxResults == 0 {
		a.MaxResults = DefaultMaxResults
	}
	if a.MaxResults < 1 || a.MaxResults > DevMaxResults {
		return fmt.Errorf("maxResults must be between 1 and %d", DevMaxResults)
	}
	types := a.Types[:0:0]
	for _, t := range a.Types {
		if !slices.Contains(DevTypes, t) {
			return fmt.Errorf("types must be among: %s", strings.Join(DevTypes, ", "))
		}
		if !slices.Contains(types, t) {
			types = append(types, t)
		}
	}
	a.Types = types
	var err error
	if a.Repos, err = cleanRepos(a.Repos); err != nil {
		return err
	}
	if len(a.Repos) > 0 && len(a.Types) == 1 && a.Types[0] == "doc" {
		return fmt.Errorf("repos selects issues, pull requests and READMEs; it cannot be combined with types [\"doc\"]")
	}
	if !DevAvailable(cfg) {
		return fmt.Errorf("dev_search is not available: no provider is enabled and configured")
	}
	return nil
}

// RunDev answers args, which must have passed Validate.
func RunDev(ctx context.Context, cfg *config.Config, client *http.Client, lim *core.Limits, args DevArgs) DevResult {
	in := DevInput{Query: args.Query, MaxResults: args.MaxResults, Types: args.Types, Repos: args.Repos}
	items, engine, err := core.RunFallback(ctx, lim, DevProviders(cfg, client), in, core.RunOptions{
		Kind:        config.ToolDevSearch,
		Target:      args.Query,
		Timeout:     time.Duration(cfg.DevSearch.TimeoutSeconds * float64(time.Second)),
		Strategy:    core.StrategyFallback,
		SingleRetry: true,
	})
	if err != nil {
		return DevResult{Query: args.Query, Results: []DevItem{}, Error: err.Error()}
	}
	return DevResult{Engine: engine, Query: args.Query, Results: items}
}

func firecrawlDevSearch(ctx context.Context, c call, in DevInput) ([]DevItem, error) {
	body := map[string]any{"query": in.Query, "k": in.MaxResults}
	if n, _ := c.opt.Int("passages"); n != 1 {
		body["passages"] = n
	}
	if len(in.Types) > 0 {
		body["types"] = in.Types
	}
	if len(in.Repos) > 0 {
		body["repos"] = in.Repos
	}
	maps.Copy(body, c.extra)

	var raw struct {
		Results []struct {
			ID       string `json:"id"`
			Type     string `json:"type"`
			URL      string `json:"url"`
			Title    string `json:"title"`
			Passages []struct {
				Text string `json:"text"`
			} `json:"passages"`
		} `json:"results"`
	}
	err := core.DoJSON(ctx, c.client, core.Request{
		Provider: "Firecrawl",
		Classify: upstream.Firecrawl,
		Method:   http.MethodPost,
		URL:      c.base + "/v2/search/developer",
		Header:   map[string]string{"Authorization": "Bearer " + c.apiKey},
		Body:     body,
	}, &raw)
	if err != nil {
		return nil, err
	}

	items := []DevItem{}
	for _, r := range raw.Results {
		item := DevItem{Type: r.Type, Title: r.Title, URL: r.URL}
		if item.Type == "" {
			// The id names the kind as well, e.g. "issue:owner/name#123".
			item.Type, _, _ = strings.Cut(r.ID, ":")
		}
		for _, p := range r.Passages {
			if text := strings.TrimSpace(p.Text); text != "" {
				item.Passages = append(item.Passages, text)
			}
		}
		items = append(items, item)
	}
	return items, nil
}
