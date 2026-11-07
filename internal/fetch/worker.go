package fetch

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/worker"
)

// Worker reads pages on the worker connected to the gateway.
type Worker interface {
	// Online reports whether a worker is connected and can reach its browser.
	Online() bool
	Fetch(ctx context.Context, req worker.Request) (*worker.Page, error)
}

// reachable reports whether a provider can take calls beyond having its
// credentials: a worker provider needs its worker online.
func reachable(provider string, w Worker) bool {
	if info, _ := config.Info(provider); !info.Worker {
		return true
	}
	return w != nil && w.Online()
}

// openCLIFetch reads a page in the worker's browser: through the site's
// adapter when one fits and the call asked for it, otherwise as it renders.
func openCLIFetch(ctx context.Context, c call, in Input) (Page, error) {
	if c.worker == nil {
		return Page{}, workerError(worker.ErrOffline)
	}
	page, err := c.worker.Fetch(ctx, worker.Request{URL: in.URL, Adapter: in.Adapter, Profile: c.profile})
	if err != nil {
		return Page{}, workerError(err)
	}
	return Page{URL: cmp.Or(page.URL, in.URL), Title: page.Title, Content: page.Content, Rendered: !in.Adapter}, nil
}

// workerError turns what the worker reports into the errors the runners
// understand. A page it could not read is the site's doing and moves on to
// the next provider; a profile OpenCLI does not know switches the provider
// off until it is fixed; a worker that cannot take the call now (offline,
// busy, without its browser) is skipped for the run; anything else is a
// plain failure, which neither trips the breaker nor says anything about the
// site.
func workerError(err error) error {
	const name = "OpenCLI"
	var e *worker.Error
	if !errors.As(err, &e) {
		switch {
		case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
			return err
		case errors.Is(err, worker.ErrOffline) || errors.Is(err, worker.ErrDisconnected):
			return &core.UnavailableError{Provider: name, Reason: err.Error()}
		}
		return fmt.Errorf("%s worker: %w", name, err)
	}
	switch e.Code {
	case worker.CodeLoginRequired:
		return &core.TargetError{Provider: name, Reason: "the browser profile is not signed in to the site: " + e.Message, Status: cmp.Or(e.Status, http.StatusUnauthorized)}
	case worker.CodeNotFound:
		return &core.TargetError{Provider: name, Reason: e.Message, Status: cmp.Or(e.Status, http.StatusNotFound)}
	case worker.CodeBlocked:
		return &core.TargetError{Provider: name, Reason: e.Message, Status: cmp.Or(e.Status, http.StatusForbidden)}
	case worker.CodeEmpty, worker.CodeTimeout, worker.CodeFailed:
		return &core.TargetError{Provider: name, Reason: e.Message, Status: e.Status}
	case worker.CodeProfileMissing:
		return &core.SetupError{Provider: name, Detail: e.Message}
	case worker.CodeBusy:
		// Its slots are taken: asking again within the run takes rate-limit
		// capacity and waits for nothing the gateway can see.
		return &core.UnavailableError{Provider: name, Reason: e.Message}
	case worker.CodeBrowserUnavailable:
		return &core.UnavailableError{Provider: name, Reason: "the worker cannot reach its browser: " + e.Message}
	}
	return fmt.Errorf("%s worker: %w", name, e)
}
