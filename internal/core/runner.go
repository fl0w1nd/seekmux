package core

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
)

// Provider is one upstream that can serve a tool call.
type Provider[In, Out any] struct {
	Name string
	// Key identifies the provider's breaker state, e.g. "brave:search".
	Key string
	// LimitKey identifies its rate and concurrency limits when they are shared
	// with other providers, e.g. "brave" for every tool Brave serves. Empty
	// means Key.
	LimitKey    string
	RateLimit   config.RateLimit
	Concurrency int
	// Available is false when the provider is disabled or lacks its API key.
	Available bool
	Execute   func(ctx context.Context, in In) (Out, error)
}

func (p Provider[In, Out]) limitKey() string { return cmp.Or(p.LimitKey, p.Key) }

// Limits is the limiter state shared by every runner.
type Limits struct {
	Rate        *RateLimiter
	Concurrency *ConcurrencyLimiter
	Breaker     *Breaker
}

func NewLimits() *Limits {
	return &Limits{Rate: NewRateLimiter(), Concurrency: NewConcurrencyLimiter(), Breaker: NewBreaker()}
}

const (
	// StrategyWait blocks on a rate-limited provider until a slot frees.
	StrategyWait = "wait"
	// StrategyFallback skips a rate-limited provider and moves to the next.
	StrategyFallback = "fallback"
)

type RunOptions struct {
	// Kind and Target label the attempts in the trace.
	Kind    string
	Target  string
	Timeout time.Duration
	// Strategy applies to RunFallback; the default is StrategyWait.
	Strategy string
	// SingleRetry retries retryable errors when only one provider is available.
	SingleRetry bool
	// SlowThreshold applies to RunHedged: an attempt slower than this gets a
	// competitor from the next provider.
	SlowThreshold time.Duration
	// NoWait makes RunFallback with StrategyFallback give up once every
	// provider left is rate limited, instead of waiting for a slot.
	NoWait bool
	// Untraced leaves the trace to providers that record their own attempts.
	Untraced bool
}

// ErrRateLimited reports that the providers not yet tried have no free
// rate-limit slot.
var ErrRateLimited = errors.New("every remaining provider is rate limited")

type providerError struct {
	name string
	err  error
}

func available[In, Out any](providers []Provider[In, Out]) ([]Provider[In, Out], error) {
	var out []Provider[In, Out]
	var names []string
	for _, p := range providers {
		names = append(names, p.Name)
		if p.Available {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("No providers available. Enable and configure one of: %s", strings.Join(names, ", "))
	}
	return out, nil
}

func summarize(errs []providerError) error {
	switch len(errs) {
	case 0:
		return errors.New("All providers failed or timed out")
	case 1:
		return errs[0].err
	}
	return fmt.Errorf("All providers failed:\n%s", listErrors(errs))
}

func listErrors(errs []providerError) string {
	lines := make([]string, len(errs))
	for i, e := range errs {
		lines[i] = fmt.Sprintf("- %s: %s", e.name, e.err)
	}
	return strings.Join(lines, "\n")
}

func timeoutError(timeout time.Duration, errs []providerError) error {
	base := &TimeoutError{Timeout: timeout}
	if len(errs) == 0 {
		return base
	}
	return fmt.Errorf("%w. Previous errors:\n%s", base, listErrors(errs))
}

// ended maps a finished run context to the error to report: the deadline of
// the run itself is a timeout, anything else is the caller going away.
func ended(ctx context.Context, timeout time.Duration, errs []providerError) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return timeoutError(timeout, errs)
	}
	return ctx.Err()
}

// disabled returns the error to report in place of calling a provider the
// breaker has switched off, and notes the skip in the trace.
func disabled[In, Out any](ctx context.Context, lim *Limits, p Provider[In, Out], opt RunOptions) error {
	trip, off := lim.Breaker.State(p.Key)
	if !off {
		return nil
	}
	why := "after repeated failures"
	switch trip.Reason {
	case ClassAuth:
		why = "because its API key was rejected"
	case ClassQuota:
		why = "because its credits ran out"
	}
	back := "until it is re-enabled"
	if !trip.Until.IsZero() {
		back = "back in " + time.Until(trip.Until).Round(time.Second).String()
	}
	err := fmt.Errorf("disabled %s, %s", why, back)
	TraceFrom(ctx).Skip(opt.Kind, p.Name, opt.Target, err.Error())
	return err
}

// report tells the breaker how a call that took elapsed ended.
func report[In, Out any](ctx context.Context, lim *Limits, p Provider[In, Out], err error, elapsed time.Duration, opt RunOptions) {
	switch {
	case err == nil:
		lim.Breaker.Success(p.Key)
	case errors.Is(ctx.Err(), context.Canceled):
		// It lost a race or the caller left; that says nothing about it.
	case ctx.Err() != nil && elapsed < opt.Timeout/2:
		// The run's time was mostly spent before this provider got its turn.
	case ctx.Err() != nil || Tripping(err):
		lim.Breaker.Failure(p.Key)
	default:
		if httpErr, ok := accountProblem(err); ok {
			lim.Breaker.Disable(p.Key, httpErr.Kind(), httpErr.Error(), httpErr.DisableFor)
		}
	}
}

func execute[In, Out any](ctx context.Context, lim *Limits, p Provider[In, Out], in In, opt RunOptions) (Out, error) {
	release, err := lim.Concurrency.Acquire(ctx, p.limitKey(), p.Concurrency)
	if err != nil {
		var zero Out
		return zero, err
	}
	defer release()
	started := time.Now()
	done := func(error) {}
	if !opt.Untraced {
		done = TraceFrom(ctx).Begin(opt.Kind, p.Name, opt.Target)
	}
	out, err := p.Execute(ctx, in)
	done(err)
	report(ctx, lim, p, err, time.Since(started), opt)
	return out, err
}

// RunFallback tries the providers in order and returns the first success
// together with the name of the provider that produced it.
func RunFallback[In, Out any](ctx context.Context, lim *Limits, providers []Provider[In, Out], in In, opt RunOptions) (Out, string, error) {
	var zero Out
	avail, err := available(providers)
	if err != nil {
		return zero, "", err
	}
	ctx, cancel := context.WithTimeout(ctx, opt.Timeout)
	defer cancel()

	if len(avail) == 1 && opt.SingleRetry {
		return runSingle(ctx, lim, avail[0], in, opt)
	}

	failed := map[string]bool{}
	// A provider passed over for its rate limit is noted once, not on every round.
	limited := map[string]bool{}
	var errs []providerError
	for len(failed) < len(avail) {
		earliest := time.Duration(-1)
		for _, p := range avail {
			if failed[p.Name] {
				continue
			}
			if ctx.Err() != nil {
				return zero, "", ended(ctx, opt.Timeout, errs)
			}
			if err := disabled(ctx, lim, p, opt); err != nil {
				errs = append(errs, providerError{p.Name, err})
				failed[p.Name] = true
				continue
			}
			if opt.Strategy == StrategyFallback {
				ok, wait := lim.Rate.TryAcquire(p.limitKey(), p.RateLimit)
				if !ok {
					if !limited[p.Name] {
						limited[p.Name] = true
						TraceFrom(ctx).Limited(opt.Kind, p.Name, opt.Target, wait)
					}
					if earliest < 0 || wait < earliest {
						earliest = wait
					}
					continue
				}
			} else if err := lim.Rate.Acquire(ctx, p.limitKey(), p.RateLimit); err != nil {
				return zero, "", ended(ctx, opt.Timeout, errs)
			}

			out, err := execute(ctx, lim, p, in, opt)
			if err == nil {
				return out, p.Name, nil
			}
			if ctx.Err() != nil {
				return zero, "", ended(ctx, opt.Timeout, errs)
			}
			errs = append(errs, providerError{p.Name, err})
			failed[p.Name] = true
		}
		if earliest < 0 {
			break
		}
		if opt.NoWait {
			errs = append(errs, providerError{"rate limit", ErrRateLimited})
			break
		}
		if err := Sleep(ctx, earliest); err != nil {
			return zero, "", ended(ctx, opt.Timeout, errs)
		}
	}
	return zero, "", summarize(errs)
}

const (
	retryBaseDelay = 500 * time.Millisecond
	retryMaxDelay  = 5 * time.Second
)

// runSingle keeps retrying the only available provider on retryable errors
// until the run deadline.
func runSingle[In, Out any](ctx context.Context, lim *Limits, p Provider[In, Out], in In, opt RunOptions) (Out, string, error) {
	var zero Out
	var errs []providerError
	for attempt := 0; ; attempt++ {
		if err := disabled(ctx, lim, p, opt); err != nil {
			return zero, "", summarize(append(errs, providerError{p.Name, err}))
		}
		if err := lim.Rate.Acquire(ctx, p.limitKey(), p.RateLimit); err != nil {
			return zero, "", ended(ctx, opt.Timeout, errs)
		}
		out, err := execute(ctx, lim, p, in, opt)
		if err == nil {
			return out, p.Name, nil
		}
		if ctx.Err() != nil {
			return zero, "", ended(ctx, opt.Timeout, errs)
		}
		if !Retryable(err) {
			return zero, "", err
		}
		errs = append(errs, providerError{p.Name, err})

		delay := min(retryBaseDelay<<min(attempt, 10), retryMaxDelay)
		if after, has := RetryAfter(err); has {
			delay = after
		}
		if ok, wait := lim.Rate.Peek(p.limitKey(), p.RateLimit); !ok {
			delay = max(delay, wait)
		}
		if err := Sleep(ctx, delay); err != nil {
			return zero, "", ended(ctx, opt.Timeout, errs)
		}
	}
}

// RunHedged starts with the first provider that has a free rate-limit slot
// and adds the next one whenever an attempt fails or stays slower than
// SlowThreshold. The first success wins and cancels the rest.
func RunHedged[In, Out any](ctx context.Context, lim *Limits, providers []Provider[In, Out], in In, opt RunOptions) (Out, string, error) {
	var zero Out
	avail, err := available(providers)
	if err != nil {
		return zero, "", err
	}
	ctx, cancel := context.WithTimeout(ctx, opt.Timeout)
	defer cancel()
	// The losers are recorded here rather than by their goroutines, which may
	// outlive the call.
	trace := TraceFrom(ctx)
	runCtx := WithTrace(ctx, nil)

	type result struct {
		name string
		out  Out
		err  error
	}
	results := make(chan result, len(avail))
	slow := make(chan struct{}, len(avail))
	started := map[string]time.Time{}
	running := map[string]bool{}
	limited := map[string]bool{}
	var errs []providerError
	var retry *time.Timer
	var retryC <-chan time.Time
	defer func() {
		if retry != nil {
			retry.Stop()
		}
	}()

	launch := func() {
		earliest := time.Duration(-1)
		note := func(wait time.Duration) {
			if earliest < 0 || wait < earliest {
				earliest = wait
			}
		}
		launched := false
		for _, p := range avail {
			if _, done := started[p.Name]; done {
				continue
			}
			if err := disabled(ctx, lim, p, opt); err != nil {
				started[p.Name] = time.Now()
				errs = append(errs, providerError{p.Name, err})
				continue
			}
			if launched {
				if ok, wait := lim.Rate.Peek(p.limitKey(), p.RateLimit); !ok {
					note(wait)
				}
				continue
			}
			ok, wait := lim.Rate.TryAcquire(p.limitKey(), p.RateLimit)
			if !ok {
				if !limited[p.Name] {
					limited[p.Name] = true
					trace.Limited(opt.Kind, p.Name, opt.Target, wait)
				}
				note(wait)
				continue
			}
			launched = true
			started[p.Name] = time.Now()
			running[p.Name] = true
			go func() {
				timer := time.AfterFunc(opt.SlowThreshold, func() { slow <- struct{}{} })
				defer timer.Stop()
				release, err := lim.Concurrency.Acquire(runCtx, p.limitKey(), p.Concurrency)
				if err != nil {
					results <- result{name: p.Name, err: err}
					return
				}
				defer release()
				began := time.Now()
				out, err := p.Execute(runCtx, in)
				report(runCtx, lim, p, err, time.Since(began), opt)
				results <- result{p.Name, out, err}
			}()
		}
		if earliest >= 0 {
			if retry != nil {
				retry.Stop()
			}
			retry = time.NewTimer(earliest)
			retryC = retry.C
		}
	}

	finish := func() {
		for name := range running {
			trace.Record(opt.Kind, name, opt.Target, started[name], context.Canceled)
		}
	}

	launch()
	for {
		if len(running) == 0 && retryC == nil {
			return zero, "", summarize(errs)
		}
		select {
		case r := <-results:
			delete(running, r.name)
			trace.Record(opt.Kind, r.name, opt.Target, started[r.name], r.err)
			if r.err == nil {
				finish()
				return r.out, r.name, nil
			}
			if ctx.Err() != nil {
				finish()
				return zero, "", ended(ctx, opt.Timeout, errs)
			}
			errs = append(errs, providerError{r.name, r.err})
			launch()
		case <-slow:
			launch()
		case <-retryC:
			retryC = nil
			launch()
		case <-ctx.Done():
			finish()
			return zero, "", ended(ctx, opt.Timeout, errs)
		}
	}
}
