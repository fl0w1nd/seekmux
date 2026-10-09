package search

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
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
	// MaxDomains bounds each domain filter: Brave takes the filters inside
	// the query, which has a length limit.
	MaxDomains = 10
)

// Args are the arguments of the search tool.
type Args struct {
	Queries    []string `json:"queries"`
	MaxResults int      `json:"maxResults"`
	TimeRange  string   `json:"time_range"`
	Engine     string   `json:"search_engine"`
	// IncludeDomains restricts results to these domains and their
	// subdomains; ExcludeDomains removes them.
	IncludeDomains []string `json:"include_domains"`
	ExcludeDomains []string `json:"exclude_domains"`
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
	var err error
	if a.IncludeDomains, err = cleanDomains("include_domains", a.IncludeDomains); err != nil {
		return err
	}
	if a.ExcludeDomains, err = cleanDomains("exclude_domains", a.ExcludeDomains); err != nil {
		return err
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
			in := Input{
				Query: query, MaxResults: args.MaxResults, TimeRange: args.TimeRange,
				IncludeDomains: args.IncludeDomains, ExcludeDomains: args.ExcludeDomains,
			}
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
			// Providers apply the filters in their own ways and not all can
			// take both at once, so the result is checked here as well.
			results[i] = QueryResult{Engine: provider, Query: out.Query, Web: filterDomains(out.Web, args), Videos: filterDomains(out.Videos, args)}
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

var domainPattern = regexp.MustCompile(`^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$`)

// cleanDomains reduces each entry, which callers also write as a URL, to a
// bare host name.
func cleanDomains(name string, list []string) ([]string, error) {
	var out []string
	for _, entry := range list {
		d := strings.ToLower(strings.TrimSpace(entry))
		if _, rest, ok := strings.Cut(d, "://"); ok {
			d = rest
		}
		d, _, _ = strings.Cut(d, "/")
		d = strings.TrimPrefix(d, "www.")
		if d == "" {
			continue
		}
		if !domainPattern.MatchString(d) {
			return nil, fmt.Errorf("%s: %q is not a domain such as example.com", name, entry)
		}
		if !slices.Contains(out, d) {
			out = append(out, d)
		}
	}
	if len(out) > MaxDomains {
		return nil, fmt.Errorf("%s takes at most %d domains", name, MaxDomains)
	}
	return out, nil
}

func inDomains(host string, domains []string) bool {
	return slices.ContainsFunc(domains, func(d string) bool { return host == d || strings.HasSuffix(host, "."+d) })
}

func filterDomains(items []Item, args Args) []Item {
	if len(args.IncludeDomains) == 0 && len(args.ExcludeDomains) == 0 {
		return items
	}
	return slices.DeleteFunc(items, func(item Item) bool {
		u, err := url.Parse(item.URL)
		if err != nil {
			return true
		}
		host := strings.ToLower(u.Hostname())
		return inDomains(host, args.ExcludeDomains) || (len(args.IncludeDomains) > 0 && !inDomains(host, args.IncludeDomains))
	})
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
