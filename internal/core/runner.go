package core

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net/http"
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
	Options     map[string]any
	ExtraBody   map[string]any
	// Available is false when the provider is disabled or lacks its API key.
	Available bool
	// NoHedge keeps it out of RunHedged's race: it starts only once no other
	// attempt is running, and nothing starts while it runs.
	NoHedge bool
	Execute func(ctx context.Context, in In) (Out, error)
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
	// GoneAfter ends the run once the site told this many providers that the
	// page does not exist, which the rest would only hear again. A single
	// provider may have been served a false 404 for being a crawler. Zero
	// tries every provider.
	GoneAfter int
	trigger   string
	try       int
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

// gone returns the error that ends a run early: the site told opt.GoneAfter
// of the providers tried that the page does not exist.
func gone(errs []providerError, opt RunOptions) error {
	if opt.GoneAfter <= 0 {
		return nil
	}
	var out GoneError
	for _, e := range errs {
		var target *TargetError
		if errors.As(e.err, &target) && (target.Status == http.StatusNotFound || target.Status == http.StatusGone) {
			out.Providers = append(out.Providers, e.name)
			out.Status = cmp.Or(out.Status, target.Status)
		}
	}
	if len(out.Providers) < opt.GoneAfter {
		return nil
	}
	return &out
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
	_, span := StartSpan(ctx, "attempt", p.Name, map[string]any{"kind": opt.Kind, "target": opt.Target, "reason": trip.Reason, "until_ms": untilMillis(trip.Until)})
	span.EndStatus("skipped", err)
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
		if !opt.Untraced {
			CurrentSpan(ctx).Set(map[string]any{"breaker": "failure"})
		}
	default:
		if httpErr, ok := accountProblem(err); ok {
			lim.Breaker.Disable(p.Key, httpErr.Kind(), httpErr.Error(), httpErr.DisableFor)
			if !opt.Untraced {
				CurrentSpan(ctx).Set(map[string]any{"breaker": "disabled"})
			}
		}
	}
}

func execute[In, Out any](ctx context.Context, lim *Limits, p Provider[In, Out], in In, opt RunOptions) (Out, error) {
	ctx, span := attemptSpan(ctx, p, opt)
	release, err := lim.Concurrency.Acquire(ctx, p.limitKey(), p.Concurrency)
	if err != nil {
		var zero Out
		span.End(err)
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
	endAttempt(span, err)
	return out, err
}

// RunFallback tries the providers in order and returns the first success
// together with the name of the provider that produced it.
func RunFallback[In, Out any](ctx context.Context, lim *Limits, providers []Provider[In, Out], in In, opt RunOptions) (out Out, winner string, runErr error) {
	ctx, span := runSpan(ctx, "fallback", opt)
	defer func() {
		if winner != "" {
			span.Set(map[string]any{"winner": winner})
		}
		span.End(runErr)
	}()
	var zero Out
	avail, err := available(providers)
	if err != nil {
		return zero, "", err
	}
	ctx, cancel := context.WithTimeout(ctx, opt.Timeout)
	defer cancel()

	if len(avail) == 1 && opt.SingleRetry {
		span.Rename("single")
		return runSingle(ctx, lim, avail[0], in, opt)
	}

	failed := map[string]bool{}
	// A provider passed over for its rate limit is noted once, not on every round.
	limited := map[string]bool{}
	var errs []providerError
	for len(failed) < len(avail) {
		earliest := time.Duration(-1)
		waitProvider := ""
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
						noteLimited(ctx, opt, p.Name, wait)
					}
					if earliest < 0 || wait < earliest {
						earliest = wait
						waitProvider = p.Name
					}
					continue
				}
			} else {
				ready := true
				if TraceFrom(ctx) != nil {
					ready, _ = lim.Rate.Peek(p.limitKey(), p.RateLimit)
				}
				if !ready {
					limited[p.Name] = true
				}
				if err := lim.Rate.Acquire(ctx, p.limitKey(), p.RateLimit); err != nil {
					return zero, "", ended(ctx, opt.Timeout, errs)
				}
			}

			opt.trigger = "first"
			if len(errs) > 0 {
				opt.trigger = "after_failure"
			}
			if limited[p.Name] {
				opt.trigger = "slot_freed"
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
			if err := gone(errs, opt); err != nil {
				return zero, "", err
			}
		}
		if earliest < 0 {
			break
		}
		if opt.NoWait {
			errs = append(errs, providerError{"rate limit", ErrRateLimited})
			break
		}
		if err := Wait(ctx, "rate_limit", waitProvider, earliest, func() error { return Sleep(ctx, earliest) }); err != nil {
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
		ready := true
		if TraceFrom(ctx) != nil {
			ready, _ = lim.Rate.Peek(p.limitKey(), p.RateLimit)
		}
		if err := lim.Rate.Acquire(ctx, p.limitKey(), p.RateLimit); err != nil {
			return zero, "", ended(ctx, opt.Timeout, errs)
		}
		opt.trigger, opt.try = "first", attempt+1
		if !ready {
			opt.trigger = "slot_freed"
		}
		if attempt > 0 {
			opt.trigger = "retry"
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
		if err := Wait(ctx, "retry", p.Name, delay, func() error { return Sleep(ctx, delay) }); err != nil {
			return zero, "", ended(ctx, opt.Timeout, errs)
		}
	}
}

// RunHedged starts with the first provider that has a free rate-limit slot
// and adds the next one whenever an attempt fails or stays slower than
// SlowThreshold. The first success wins and cancels the rest. A provider
// with NoHedge waits its turn until nothing else runs, and then runs alone.
func RunHedged[In, Out any](ctx context.Context, lim *Limits, providers []Provider[In, Out], in In, opt RunOptions) (out Out, winner string, runErr error) {
	ctx, span := runSpan(ctx, "hedged", opt)
	defer func() {
		if winner != "" {
			span.Set(map[string]any{"winner": winner})
		}
		span.End(runErr)
	}()
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
	spans := map[string]*Span{}

	type result struct {
		name string
		out  Out
		err  error
	}
	results := make(chan result, len(avail))
	slow := make(chan struct{}, len(avail))
	started := map[string]time.Time{}
	running := map[string]bool{}
	// solo holds the running providers that do not race.
	solo := map[string]bool{}
	limited := map[string]bool{}
	var errs []providerError
	var retry *time.Timer
	var retryC <-chan time.Time
	var retryWait *Span
	defer func() {
		if retry != nil {
			retry.Stop()
		}
		retryWait.End(context.Canceled)
	}()

	launch := func(trigger string) {
		for name := range running {
			if solo[name] {
				return
			}
		}
		earliest := time.Duration(-1)
		waitProvider := ""
		note := func(provider string, wait time.Duration) {
			if earliest < 0 || wait < earliest {
				earliest = wait
				waitProvider = provider
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
			if p.NoHedge && (launched || len(running) > 0) {
				// It waits for the attempts under way, and so do the
				// providers after it.
				break
			}
			if launched {
				if ok, wait := lim.Rate.Peek(p.limitKey(), p.RateLimit); !ok {
					note(p.Name, wait)
				}
				continue
			}
			ok, wait := lim.Rate.TryAcquire(p.limitKey(), p.RateLimit)
			if !ok {
				if !limited[p.Name] {
					limited[p.Name] = true
					noteLimited(ctx, opt, p.Name, wait)
				}
				note(p.Name, wait)
				continue
			}
			launched = true
			started[p.Name] = time.Now()
			running[p.Name] = true
			solo[p.Name] = p.NoHedge
			launchOpt := opt
			launchOpt.trigger = trigger
			runCtx, attempt := attemptSpan(ctx, p, launchOpt)
			spans[p.Name] = attempt
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
			retryWait.End(nil)
			if earliest > 5*time.Millisecond {
				_, retryWait = StartSpan(ctx, "wait", "rate_limit", map[string]any{"provider": waitProvider, "wait_ms": earliest.Milliseconds()})
			}
			retry = time.NewTimer(earliest)
			retryC = retry.C
		}
	}

	finish := func() {
		for name := range running {
			if !opt.Untraced {
				trace.Record(opt.Kind, name, opt.Target, started[name], context.Canceled)
			}
			endAttempt(spans[name], context.Canceled)
		}
	}

	launch("first")
	for {
		if len(running) == 0 && retryC == nil {
			return zero, "", summarize(errs)
		}
		select {
		case r := <-results:
			delete(running, r.name)
			if !opt.Untraced {
				trace.Record(opt.Kind, r.name, opt.Target, started[r.name], r.err)
			}
			endAttempt(spans[r.name], r.err)
			if r.err == nil {
				finish()
				return r.out, r.name, nil
			}
			if ctx.Err() != nil {
				finish()
				return zero, "", ended(ctx, opt.Timeout, errs)
			}
			errs = append(errs, providerError{r.name, r.err})
			if err := gone(errs, opt); err != nil {
				finish()
				return zero, "", err
			}
			launch("after_failure")
		case <-slow:
			launch("slow")
		case <-retryC:
			retryWait.End(nil)
			retryC = nil
			launch("slot_freed")
		case <-ctx.Done():
			finish()
			return zero, "", ended(ctx, opt.Timeout, errs)
		}
	}
}
