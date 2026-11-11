// Package social searches social platforms through the workers of a
// self-hosted fetcher, which are signed in to them. X is the first: the
// x_search tool.
package social

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/search"
	"github.com/fl0w1nd/seekmux/internal/worker"
)

const (
	// DefaultMaxResults and MaxResults bound the posts of one call: OpenCLI
	// scrolls the results page for more, which takes as long for 50 as for
	// 20 but costs the caller's context.
	DefaultMaxResults = 10
	MaxResults        = 50

	SortTop    = "top"
	SortLatest = "latest"
)

// Sorts are the values of x_search's sort argument.
var Sorts = []string{SortTop, SortLatest}

// Workers runs searches on the workers connected to the gateway, each by its
// id.
type Workers interface {
	// Online reports whether the worker is connected and can reach its
	// browser.
	Online(id string) bool
	Search(ctx context.Context, id string, req worker.SearchRequest) ([]worker.Post, error)
}

// XArgs are the arguments of the x_search tool.
type XArgs struct {
	Query      string `json:"query"`
	Sort       string `json:"sort"`
	MaxResults int    `json:"maxResults"`
	// TimeRange keeps posts of the last day, week, month or year, as the
	// search tool's does.
	TimeRange string `json:"time_range"`
}

// XResult is the answer of the x_search tool.
type XResult struct {
	// Fetcher is the self-hosted fetcher that searched, for the log.
	Fetcher string `json:"-"`
	// Query is the query as X received it, with the operators the
	// arguments added.
	Query string        `json:"query"`
	Posts []worker.Post `json:"posts"`
	Error string        `json:"error,omitempty"`
}

// XAvailable reports whether the x_search tool can be offered under cfg.
func XAvailable(cfg *config.Config) bool { return cfg.SocialAvailable(config.PlatformX) }

// Validate checks args against cfg and applies the defaults.
func (a *XArgs) Validate(cfg *config.Config) error {
	if a.Query = strings.TrimSpace(a.Query); a.Query == "" {
		return fmt.Errorf("query is required")
	}
	if a.Sort = cmp.Or(strings.TrimSpace(a.Sort), SortTop); !slices.Contains(Sorts, a.Sort) {
		return fmt.Errorf("sort must be one of: %s", strings.Join(Sorts, ", "))
	}
	if a.MaxResults == 0 {
		a.MaxResults = DefaultMaxResults
	}
	if a.MaxResults < 1 || a.MaxResults > MaxResults {
		return fmt.Errorf("maxResults must be between 1 and %d", MaxResults)
	}
	if a.TimeRange != "" && !slices.Contains(search.TimeRanges, a.TimeRange) {
		return fmt.Errorf("time_range must be one of: %s", strings.Join(search.TimeRanges, ", "))
	}
	if !XAvailable(cfg) {
		return fmt.Errorf("x_search is not available: X has no worker to search with")
	}
	return nil
}

// since returns the first day, in UTC, of a time range ending now.
func since(timeRange string, now time.Time) string {
	now = now.UTC()
	var start time.Time
	switch timeRange {
	case "day":
		start = now.AddDate(0, 0, -1)
	case "week":
		start = now.AddDate(0, 0, -7)
	case "month":
		start = now.AddDate(0, -1, 0)
	case "year":
		start = now.AddDate(-1, 0, 0)
	default:
		return ""
	}
	return start.Format(time.DateOnly)
}

// query is what X is asked: the caller's query, narrowed to the time range.
func (a XArgs) query(now time.Time) string {
	if day := since(a.TimeRange, now); day != "" {
		return a.Query + " since:" + day
	}
	return a.Query
}

type xInput struct {
	query string
	sort  string
	limit int
}

// RunX answers args, which must have passed Validate.
func RunX(ctx context.Context, cfg *config.Config, lim *core.Limits, w Workers, args XArgs) XResult {
	in := xInput{query: args.query(time.Now()), sort: args.Sort, limit: args.MaxResults}
	result := XResult{Query: in.query, Posts: []worker.Post{}}
	f, workers, ok := cfg.SourceWorkers(config.PlatformX)
	if !ok || len(workers) == 0 {
		result.Error = "X search is unavailable: no worker is set to search X"
		return result
	}
	result.Fetcher = f.ID
	if w == nil || !slices.ContainsFunc(workers, func(wk config.Worker) bool { return w.Online(wk.ID) }) {
		result.Error = fmt.Sprintf("X search is unavailable: the fetcher %q is offline (none of its workers for X is connected with its browser ready)", f.Name)
		core.MarkResult(ctx, errors.New(result.Error), nil)
		return result
	}

	limit, concurrency := cfg.Limits(f.ID)
	provider := core.Provider[xInput, []worker.Post]{
		Name: f.ID,
		Key:  f.ID + ":" + config.ToolXSearch,
		// The fetcher's limits are shared with the pages it reads.
		LimitKey:    f.ID,
		RateLimit:   limit,
		Concurrency: concurrency,
		Available:   true,
		Execute: func(ctx context.Context, in xInput) ([]worker.Post, error) {
			posts, err := searchX(ctx, w, f, workers, in)
			if err == nil {
				core.CurrentSpan(ctx).Set(map[string]any{"results": len(posts)})
			}
			return posts, err
		},
	}
	posts, _, err := core.RunFallback(ctx, lim, []core.Provider[xInput, []worker.Post]{provider}, in, core.RunOptions{
		Kind:     config.ToolXSearch,
		Target:   in.query,
		Timeout:  time.Duration(cfg.Social.TimeoutSeconds * float64(time.Second)),
		Strategy: core.StrategyWait,
	})
	core.MarkResult(ctx, err, map[string]any{"posts": len(posts)})
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if posts != nil {
		result.Posts = posts
	}
	return result
}

// searchX runs the search on the first of workers that takes it. A worker
// that cannot (offline, busy, without its browser or profile, too old,
// failing in itself) hands it to the next; a search X refused ends there,
// as the next worker would most likely be refused too.
func searchX(ctx context.Context, w Workers, f *config.Fetcher, workers []config.Worker, in xInput) ([]worker.Post, error) {
	var skipped []string
	for _, wk := range workers {
		workerCtx, span := core.StartSpan(ctx, "worker", wk.Name, map[string]any{"worker_id": wk.ID, "profile": wk.Profile})
		posts, err := w.Search(workerCtx, wk.ID, worker.SearchRequest{
			Site: config.PlatformX, Feature: worker.FeatureXSearch,
			Query: in.query, Sort: in.sort, Limit: in.limit, Profile: wk.Profile,
		})
		if err == nil {
			span.End(nil)
			return posts, nil
		}
		if ctx.Err() != nil {
			span.EndStatus("error", ctx.Err())
			return nil, ctx.Err()
		}
		if !workerFault(err) {
			span.EndStatus("error", err)
			return nil, searchError(err)
		}
		span.EndStatus("skipped", err)
		skipped = append(skipped, fmt.Sprintf("%s: %v", wk.Name, err))
	}
	return nil, &core.UnavailableError{Provider: "X search", Reason: fmt.Sprintf("no worker of the fetcher %q could take it (%s)", f.Name, strings.Join(skipped, "; "))}
}

// workerFault reports whether a failure is the worker's own rather than
// the search's, so that the next worker may try.
func workerFault(err error) bool {
	var e *worker.Error
	if !errors.As(err, &e) {
		// Not connected, gone during the search, or a failure of the
		// connection.
		return true
	}
	switch e.Code {
	case worker.CodeBusy, worker.CodeBrowserUnavailable, worker.CodeProfileMissing, worker.CodeInternal, worker.CodeOutdated:
		return true
	}
	return false
}

// searchError words a search the worker ran and X turned down.
func searchError(err error) error {
	var e *worker.Error
	if !errors.As(err, &e) {
		return err
	}
	switch e.Code {
	case worker.CodeLoginRequired:
		return fmt.Errorf("X search failed: the browser profile is not signed in to X: %s", e.Message)
	case worker.CodeBlocked:
		return fmt.Errorf("X search failed: X refused or rate limited the search: %s", e.Message)
	case worker.CodeTimeout:
		return fmt.Errorf("X search failed: the search took too long: %s", e.Message)
	}
	return fmt.Errorf("X search failed: %s", e.Message)
}
