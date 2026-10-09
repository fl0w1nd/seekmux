package search

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
)

const (
	EngineAuto        = "auto"
	MaxQueries        = 3
	DefaultMaxResults = 5
)

// Args are the arguments of the search tool.
type Args struct {
	Queries    []string `json:"queries"`
	MaxResults int      `json:"maxResults"`
	TimeRange  string   `json:"time_range"`
	Engine     string   `json:"search_engine"`
}

// QueryResult is the answer to one query.
type QueryResult struct {
	Engine string `json:"search_engine,omitempty"`
	Query  string `json:"query"`
	Web    []Item `json:"web,omitempty"`
	Videos []Item `json:"videos,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Engines lists the values search_engine accepts under cfg.
func Engines(cfg *config.Config) []string {
	engines := []string{EngineAuto}
	for _, p := range Providers(cfg, nil) {
		if p.Available {
			engines = append(engines, p.Name)
		}
	}
	return engines
}

// Validate checks args against cfg and applies the defaults.
func (a *Args) Validate(cfg *config.Config) error {
	queries := a.Queries[:0:0]
	for _, q := range a.Queries {
		if q = strings.TrimSpace(q); q != "" {
			queries = append(queries, q)
		}
	}
	if len(queries) == 0 {
		return fmt.Errorf("queries must contain at least one non-empty query")
	}
	a.Queries = queries[:min(len(queries), MaxQueries)]

	if a.MaxResults == 0 {
		a.MaxResults = DefaultMaxResults
	}
	if a.MaxResults < 1 || a.MaxResults > 100 {
		return fmt.Errorf("maxResults must be between 1 and 100")
	}
	if a.TimeRange != "" && !slices.Contains(TimeRanges, a.TimeRange) {
		return fmt.Errorf("time_range must be one of: %s", strings.Join(TimeRanges, ", "))
	}
	if a.Engine == "" {
		a.Engine = EngineAuto
	}
	if engines := Engines(cfg); !slices.Contains(engines, a.Engine) {
		return fmt.Errorf("search_engine %q is not available; use one of: %s", a.Engine, strings.Join(engines, ", "))
	}
	return nil
}

// Run answers every query concurrently and removes URLs repeated across them.
// Args must have passed Validate.
func Run(ctx context.Context, cfg *config.Config, client *http.Client, lim *core.Limits, args Args) []QueryResult {
	providers := Providers(cfg, client)
	strategy := core.StrategyFallback
	if args.Engine != EngineAuto {
		providers = slices.DeleteFunc(providers, func(p core.Provider[Input, Output]) bool { return p.Name != args.Engine })
		strategy = core.StrategyWait
	}

	results := make([]QueryResult, len(args.Queries))
	var wg sync.WaitGroup
	for i, query := range args.Queries {
		wg.Go(func() {
			in := Input{Query: query, MaxResults: args.MaxResults, TimeRange: args.TimeRange}
			out, provider, err := core.RunFallback(ctx, lim, providers, in, core.RunOptions{
				Kind:        config.ToolSearch,
				Target:      query,
				Timeout:     time.Duration(cfg.Search.TimeoutSeconds * float64(time.Second)),
				Strategy:    strategy,
				SingleRetry: true,
			})
			if err != nil {
				results[i] = QueryResult{Query: query, Error: err.Error()}
				return
			}
			if out.Query == "" {
				out.Query = query
			}
			results[i] = QueryResult{Engine: provider, Query: out.Query, Web: out.Web, Videos: out.Videos}
		})
	}
	wg.Wait()

	seen := map[string]bool{}
	for i := range results {
		results[i].Web = dedupe(results[i].Web, seen)
		results[i].Videos = dedupe(results[i].Videos, seen)
	}
	return results
}

func dedupe(items []Item, seen map[string]bool) []Item {
	return slices.DeleteFunc(items, func(item Item) bool {
		if item.URL == "" {
			return false
		}
		key := normalizeURL(item.URL)
		if seen[key] {
			return true
		}
		seen[key] = true
		return false
	})
}

func normalizeURL(raw string) string {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return strings.TrimRight(raw, "/")
	}
	u.Fragment = ""
	if len(u.Path) > 1 {
		u.Path = strings.TrimRight(u.Path, "/")
		u.RawPath = ""
	}
	return u.String()
}
