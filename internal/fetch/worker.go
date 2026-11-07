package fetch

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/worker"
)

// Workers reads pages on the workers connected to the gateway, each by its
// id.
type Workers interface {
	// Online reports whether the worker is connected and can reach its
	// browser.
	Online(id string) bool
	Fetch(ctx context.Context, id string, req worker.Request) (*worker.Page, error)
}

// fetcherExecutors serve the self-hosted fetchers, by type.
var fetcherExecutors = map[string]executor{
	config.FetcherOpenCLI: openCLIFetch,
}

// reachable reports whether a provider can take calls beyond having its
// credentials: a self-hosted fetcher needs one of its workers that is
// switched on to be online.
func reachable(cfg *config.Config, provider string, w Workers) bool {
	f, ok := cfg.FetcherByID(provider)
	if !ok {
		return true
	}
	return w != nil && slices.ContainsFunc(f.Workers, func(wk config.Worker) bool { return wk.Enabled && w.Online(wk.ID) })
}

// openCLIFetch reads a page through the first of the fetcher's workers that
// takes it: through the site's adapter when one fits and the call asked for
// it, otherwise as it renders. A worker that cannot (offline, every slot
// taken, without its browser or its profile, failing in itself) hands the
// page to the next one; a page the worker could not read ends the fetcher's
// attempt, as the next worker would most likely fail on it too.
func openCLIFetch(ctx context.Context, c call, in Input) (Page, error) {
	name := c.fetcher.Name
	var skipped []string
	for _, wk := range c.fetcher.Workers {
		if !wk.Enabled {
			continue
		}
		var page *worker.Page
		err := worker.ErrOffline
		if c.workers != nil {
			page, err = c.workers.Fetch(ctx, wk.ID, worker.Request{URL: in.URL, Adapter: in.Adapter, Profile: wk.Profile})
		}
		if err == nil {
			return Page{URL: cmp.Or(page.URL, in.URL), Title: page.Title, Content: page.Content, Rendered: !in.Adapter}, nil
		}
		if ctx.Err() != nil {
			return Page{}, ctx.Err()
		}
		if !workerFault(err) {
			return Page{}, pageError(name, err)
		}
		skipped = append(skipped, fmt.Sprintf("%s: %v", wk.Name, err))
	}
	reason := "no worker is switched on"
	if len(skipped) > 0 {
		reason = "no worker could take the page (" + strings.Join(skipped, "; ") + ")"
	}
	return Page{}, &core.UnavailableError{Provider: name, Reason: reason}
}

// workerFault reports whether a failure is the worker's own rather than the
// page's, so that the next worker may try.
func workerFault(err error) bool {
	var e *worker.Error
	if !errors.As(err, &e) {
		// Not connected, gone during the fetch, or a failure of the
		// connection.
		return true
	}
	switch e.Code {
	case worker.CodeBusy, worker.CodeBrowserUnavailable, worker.CodeProfileMissing, worker.CodeInternal:
		return true
	}
	return false
}

// pageError turns a page the worker could not read into the error the
// runners understand: the site's doing, which moves on to the next provider
// and neither trips the breaker nor counts against the fetcher.
func pageError(name string, err error) error {
	var e *worker.Error
	if !errors.As(err, &e) {
		return fmt.Errorf("%s: %w", name, err)
	}
	switch e.Code {
	case worker.CodeLoginRequired:
		return &core.TargetError{Provider: name, Reason: "the browser profile is not signed in to the site: " + e.Message, Status: cmp.Or(e.Status, http.StatusUnauthorized)}
	case worker.CodeNotFound:
		return &core.TargetError{Provider: name, Reason: e.Message, Status: cmp.Or(e.Status, http.StatusNotFound)}
	case worker.CodeBlocked:
		return &core.TargetError{Provider: name, Reason: e.Message, Status: cmp.Or(e.Status, http.StatusForbidden)}
	}
	return &core.TargetError{Provider: name, Reason: e.Message, Status: e.Status}
}
