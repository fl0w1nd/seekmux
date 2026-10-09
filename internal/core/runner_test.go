package core

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
)

func provider(name string, limit config.RateLimit, run func(ctx context.Context) (string, error)) Provider[string, string] {
	return Provider[string, string]{
		Name: name, Key: name, RateLimit: limit, Available: true,
		Execute: func(ctx context.Context, _ string) (string, error) { return run(ctx) },
	}
}

func ok(value string) func(context.Context) (string, error) {
	return func(context.Context) (string, error) { return value, nil }
}

func fail(err error) func(context.Context) (string, error) {
	return func(context.Context) (string, error) { return "", err }
}

func slow(d time.Duration, value string) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		if err := Sleep(ctx, d); err != nil {
			return "", err
		}
		return value, nil
	}
}

func TestRateLimiterWindow(t *testing.T) {
	l := NewRateLimiter()
	limit := config.RateLimit{Requests: 2, Window: 80 * time.Millisecond}
	for i := range 2 {
		if ok, _ := l.TryAcquire("k", limit); !ok {
			t.Fatalf("slot %d should be free", i)
		}
	}
	ok, wait := l.TryAcquire("k", limit)
	if ok || wait <= 0 || wait > limit.Window {
		t.Fatalf("third call: ok=%v wait=%v", ok, wait)
	}
	if used := l.Used("k", limit); used != 2 {
		t.Fatalf("used = %d", used)
	}
	if err := l.Acquire(context.Background(), "k", limit); err != nil {
		t.Fatal(err)
	}
	if ok, _ := l.TryAcquire("k", config.RateLimit{}); !ok {
		t.Fatal("a zero limit is unlimited")
	}
}

func TestConcurrencyLimiterHandsOver(t *testing.T) {
	l := NewConcurrencyLimiter()
	release, _ := l.Acquire(context.Background(), "k", 1)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := l.Acquire(ctx, "k", 1); err == nil {
		t.Fatal("a canceled waiter must not get the slot")
	}

	got := make(chan func(), 1)
	go func() {
		r, _ := l.Acquire(context.Background(), "k", 1)
		got <- r
	}()
	time.Sleep(20 * time.Millisecond)
	release()
	select {
	case r := <-got:
		r()
	case <-time.After(time.Second):
		t.Fatal("the waiter never got the slot")
	}
	if n := l.Active("k"); n != 0 {
		t.Fatalf("active = %d", n)
	}
}

func TestRunFallbackMovesOnAfterError(t *testing.T) {
	trace := NewTrace()
	ctx := WithTrace(context.Background(), trace)
	out, name, err := RunFallback(ctx, NewLimits(), []Provider[string, string]{
		provider("a", config.RateLimit{}, fail(&HTTPError{Provider: "A", StatusCode: 500})),
		provider("b", config.RateLimit{}, ok("B")),
	}, "", RunOptions{Kind: "search", Timeout: time.Second})
	if err != nil || out != "B" || name != "b" {
		t.Fatalf("out=%q name=%q err=%v", out, name, err)
	}
	attempts := trace.Attempts()
	if len(attempts) != 2 || attempts[0].Status != AttemptError || attempts[0].HTTPStatus != 500 || attempts[1].Status != AttemptOK {
		t.Fatalf("attempts = %+v", attempts)
	}
}

func TestRunFallbackSkipsRateLimitedProvider(t *testing.T) {
	lim := NewLimits()
	limit := config.RateLimit{Requests: 1, Window: time.Minute}
	lim.Rate.TryAcquire("a", limit)
	_, name, err := RunFallback(context.Background(), lim, []Provider[string, string]{
		provider("a", limit, ok("A")),
		provider("b", config.RateLimit{}, ok("B")),
	}, "", RunOptions{Timeout: time.Second, Strategy: StrategyFallback})
	if err != nil || name != "b" {
		t.Fatalf("name=%q err=%v", name, err)
	}
}

func TestRunFallbackWaitsWhenEveryProviderIsRateLimited(t *testing.T) {
	lim := NewLimits()
	limit := config.RateLimit{Requests: 1, Window: 60 * time.Millisecond}
	lim.Rate.TryAcquire("a", limit)
	started := time.Now()
	_, name, err := RunFallback(context.Background(), lim, []Provider[string, string]{
		provider("a", limit, ok("A")),
		provider("b", config.RateLimit{}, fail(errors.New("boom"))),
	}, "", RunOptions{Timeout: time.Second, Strategy: StrategyFallback})
	if err != nil || name != "a" || time.Since(started) < 40*time.Millisecond {
		t.Fatalf("name=%q err=%v after %v", name, err, time.Since(started))
	}
}

func TestRunFallbackReportsEveryError(t *testing.T) {
	_, _, err := RunFallback(context.Background(), NewLimits(), []Provider[string, string]{
		provider("a", config.RateLimit{}, fail(errors.New("one"))),
		provider("b", config.RateLimit{}, fail(errors.New("two"))),
	}, "", RunOptions{Timeout: time.Second})
	if err == nil || !strings.Contains(err.Error(), "- a: one") || !strings.Contains(err.Error(), "- b: two") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunFallbackTimesOut(t *testing.T) {
	_, _, err := RunFallback(context.Background(), NewLimits(), []Provider[string, string]{
		provider("a", config.RateLimit{}, slow(time.Second, "A")),
	}, "", RunOptions{Timeout: 50 * time.Millisecond})
	var timeout *TimeoutError
	if !errors.As(err, &timeout) {
		t.Fatalf("err = %v", err)
	}
}

func TestRunFallbackNoProviders(t *testing.T) {
	p := provider("a", config.RateLimit{}, ok("A"))
	p.Available = false
	_, _, err := RunFallback(context.Background(), NewLimits(), []Provider[string, string]{p}, "", RunOptions{Timeout: time.Second})
	if err == nil || !strings.Contains(err.Error(), "No providers available") {
		t.Fatalf("err = %v", err)
	}
}

func TestSingleProviderRetriesRetryableErrors(t *testing.T) {
	var calls atomic.Int32
	p := provider("a", config.RateLimit{}, func(context.Context) (string, error) {
		if calls.Add(1) < 3 {
			return "", &HTTPError{Provider: "A", StatusCode: 429, HasRetry: true, RetryAfter: 10 * time.Millisecond}
		}
		return "A", nil
	})
	out, _, err := RunFallback(context.Background(), NewLimits(), []Provider[string, string]{p}, "", RunOptions{Timeout: time.Second, SingleRetry: true})
	if err != nil || out != "A" || calls.Load() != 3 {
		t.Fatalf("out=%q err=%v calls=%d", out, err, calls.Load())
	}

	calls.Store(0)
	p = provider("a", config.RateLimit{}, func(context.Context) (string, error) {
		calls.Add(1)
		return "", &HTTPError{Provider: "A", StatusCode: 401}
	})
	if _, _, err := RunFallback(context.Background(), NewLimits(), []Provider[string, string]{p}, "", RunOptions{Timeout: time.Second, SingleRetry: true}); err == nil || calls.Load() != 1 {
		t.Fatalf("a 401 must not be retried: err=%v calls=%d", err, calls.Load())
	}
}

func TestRunHedgedRacesSlowProvider(t *testing.T) {
	trace := NewTrace()
	ctx := WithTrace(context.Background(), trace)
	started := time.Now()
	out, name, err := RunHedged(ctx, NewLimits(), []Provider[string, string]{
		provider("a", config.RateLimit{}, slow(2*time.Second, "A")),
		provider("b", config.RateLimit{}, slow(20*time.Millisecond, "B")),
	}, "", RunOptions{Kind: "fetch", Timeout: 3 * time.Second, SlowThreshold: 50 * time.Millisecond})
	if err != nil || out != "B" || name != "b" || time.Since(started) > time.Second {
		t.Fatalf("out=%q name=%q err=%v after %v", out, name, err, time.Since(started))
	}
	attempts := trace.Attempts()
	if len(attempts) != 2 || attempts[0].Provider != "b" || attempts[1].Provider != "a" || attempts[1].Status != AttemptCanceled {
		t.Fatalf("attempts = %+v", attempts)
	}
}

func TestRunHedgedFailsOverImmediately(t *testing.T) {
	started := time.Now()
	_, name, err := RunHedged(context.Background(), NewLimits(), []Provider[string, string]{
		provider("a", config.RateLimit{}, fail(errors.New("boom"))),
		provider("b", config.RateLimit{}, ok("B")),
	}, "", RunOptions{Timeout: time.Second, SlowThreshold: 500 * time.Millisecond})
	if err != nil || name != "b" || time.Since(started) > 200*time.Millisecond {
		t.Fatalf("name=%q err=%v after %v", name, err, time.Since(started))
	}
}

func TestRunHedgedWaitsForRateLimitedProvider(t *testing.T) {
	lim := NewLimits()
	limit := config.RateLimit{Requests: 1, Window: 60 * time.Millisecond}
	lim.Rate.TryAcquire("b", limit)
	_, name, err := RunHedged(context.Background(), lim, []Provider[string, string]{
		provider("a", config.RateLimit{}, fail(errors.New("boom"))),
		provider("b", limit, ok("B")),
	}, "", RunOptions{Timeout: time.Second, SlowThreshold: 500 * time.Millisecond})
	if err != nil || name != "b" {
		t.Fatalf("name=%q err=%v", name, err)
	}
}

func TestRunHedgedAllFail(t *testing.T) {
	_, _, err := RunHedged(context.Background(), NewLimits(), []Provider[string, string]{
		provider("a", config.RateLimit{}, fail(errors.New("one"))),
		provider("b", config.RateLimit{}, fail(errors.New("two"))),
	}, "", RunOptions{Timeout: time.Second, SlowThreshold: 500 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "All providers failed") {
		t.Fatalf("err = %v", err)
	}
}

func TestCacheEvictsBySizeAndTTL(t *testing.T) {
	c := NewCache(10, func(s string) int { return len(s) })
	c.Set("a", "12345", time.Minute)
	c.Set("b", "12345", time.Minute)
	c.Set("c", "12345", time.Minute)
	if _, ok := c.Get("a"); ok {
		t.Fatal("the oldest entry should be evicted")
	}
	if _, ok := c.Get("c"); !ok {
		t.Fatal("the newest entry should stay")
	}
	c.Set("d", "1", time.Millisecond)
	time.Sleep(5 * time.Millisecond)
	if _, ok := c.Get("d"); ok {
		t.Fatal("an expired entry must not be returned")
	}
}

func TestFallbackNoWaitGivesUpWhenRateLimited(t *testing.T) {
	lim := NewLimits()
	limit := config.RateLimit{Requests: 1, Window: time.Minute}
	lim.Rate.TryAcquire("b", limit)
	providers := []Provider[string, string]{
		provider("a", config.RateLimit{}, fail(errors.New("boom"))),
		provider("b", limit, ok("b")),
	}
	started := time.Now()
	_, _, err := RunFallback(context.Background(), lim, providers, "", RunOptions{Timeout: time.Second, Strategy: StrategyFallback, NoWait: true})
	if err == nil || !strings.Contains(err.Error(), "boom") || !strings.Contains(err.Error(), ErrRateLimited.Error()) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(started) > 200*time.Millisecond {
		t.Fatal("NoWait must not wait for the rate limit window")
	}
}

func TestBreakerSkipsAFailingProviderUntilCooldown(t *testing.T) {
	lim := NewLimits()
	lim.Breaker.Configure(BreakerSettings{Enabled: true, Failures: 2, Window: time.Minute, Cooldown: 60 * time.Millisecond})
	var calls atomic.Int32
	healthy := atomic.Bool{}
	providers := []Provider[string, string]{
		provider("a", config.RateLimit{}, func(context.Context) (string, error) {
			calls.Add(1)
			if healthy.Load() {
				return "a", nil
			}
			return "", &HTTPError{Provider: "a", StatusCode: 503}
		}),
		provider("b", config.RateLimit{}, ok("b")),
	}
	run := func() string {
		t.Helper()
		_, name, err := RunFallback(context.Background(), lim, providers, "", RunOptions{Timeout: time.Second, Strategy: StrategyFallback})
		if err != nil {
			t.Fatal(err)
		}
		return name
	}
	for range 2 {
		run()
	}
	if _, off := lim.Breaker.State("a"); !off {
		t.Fatal("two failures in a row must disable the provider")
	}
	if run() != "b" || calls.Load() != 2 {
		t.Fatalf("a disabled provider must not be called, calls = %d", calls.Load())
	}

	// On probation after the cooldown, one failure disables it again.
	time.Sleep(80 * time.Millisecond)
	run()
	if _, off := lim.Breaker.State("a"); !off || calls.Load() != 3 {
		t.Fatalf("a failure on probation must disable again, calls = %d", calls.Load())
	}

	time.Sleep(80 * time.Millisecond)
	healthy.Store(true)
	if run() != "a" {
		t.Fatal("a recovered provider must serve again")
	}
	healthy.Store(false)
	run()
	if _, off := lim.Breaker.State("a"); off {
		t.Fatal("a success must clear the record, so one new failure is not enough")
	}
}

func TestBreakerIgnoresRequestErrorsAndLostRaces(t *testing.T) {
	lim := NewLimits()
	lim.Breaker.Configure(BreakerSettings{Enabled: true, Failures: 1, Window: time.Minute, Cooldown: time.Minute})
	rejected := []Provider[string, string]{provider("a", config.RateLimit{}, fail(&HTTPError{Provider: "a", StatusCode: 400}))}
	RunFallback(context.Background(), lim, rejected, "", RunOptions{Timeout: time.Second})
	if _, off := lim.Breaker.State("a"); off {
		t.Fatal("a rejected request says nothing about the provider")
	}

	race := []Provider[string, string]{
		provider("slow", config.RateLimit{}, slow(500*time.Millisecond, "slow")),
		provider("fast", config.RateLimit{}, ok("fast")),
	}
	if _, name, err := RunHedged(context.Background(), lim, race, "", RunOptions{Timeout: time.Second, SlowThreshold: 20 * time.Millisecond}); err != nil || name != "fast" {
		t.Fatalf("name = %q, err = %v", name, err)
	}
	time.Sleep(30 * time.Millisecond)
	if _, off := lim.Breaker.State("slow"); off {
		t.Fatal("losing a race must not count as a failure")
	}
}

func TestBreakerDisablesAtOnceOnAccountProblems(t *testing.T) {
	lim := NewLimits()
	lim.Breaker.Configure(BreakerSettings{Enabled: true, Failures: 3, Window: time.Minute, Cooldown: time.Minute})
	run := func(name string, err error) {
		RunFallback(context.Background(), lim, []Provider[string, string]{provider(name, config.RateLimit{}, fail(err))}, "", RunOptions{Timeout: time.Second})
	}

	run("key", &HTTPError{Provider: "key", StatusCode: 401, Body: "bad key"})
	if trip, off := lim.Breaker.State("key"); !off || !trip.Until.IsZero() || trip.Reason != ClassAuth || !strings.Contains(trip.Detail, "bad key") {
		t.Fatalf("a rejected key must disable at once, until re-enabled: %+v %v", trip, off)
	}
	run("quota", &HTTPError{Provider: "quota", StatusCode: 429, Class: ClassQuota, DisableFor: time.Hour})
	if trip, off := lim.Breaker.State("quota"); !off || trip.Reason != ClassQuota || time.Until(trip.Until) < 59*time.Minute {
		t.Fatalf("a quota with a known reset comes back by itself: %+v %v", trip, off)
	}
	run("site", &TargetError{Provider: "site", Reason: "the site answered 404"})
	run("site", &HTTPError{Provider: "site", StatusCode: 500, Class: ClassTarget})
	run("site", &HTTPError{Provider: "site", StatusCode: 500, Class: ClassTarget})
	if _, off := lim.Breaker.State("site"); off {
		t.Fatal("a page that cannot be fetched says nothing about the provider")
	}

	// Saving the configuration is how a key gets fixed.
	lim.Breaker.Configure(BreakerSettings{Enabled: true, Failures: 3, Window: time.Minute, Cooldown: time.Minute})
	if _, off := lim.Breaker.State("key"); off {
		t.Fatal("configuring must re-enable everything")
	}

	run("key", &HTTPError{Provider: "key", StatusCode: 401})
	lim.Breaker.Reset("key")
	if _, off := lim.Breaker.State("key"); off {
		t.Fatal("a reset must re-enable it")
	}
}

func TestBreakerKeepsAnAccountDisableThroughALateSuccess(t *testing.T) {
	b := NewBreaker()
	b.Configure(BreakerSettings{Enabled: true, Failures: 3, Window: time.Minute, Cooldown: time.Minute})
	b.Disable("a", ClassAuth, "bad key", 0)
	b.Success("a")
	if _, off := b.State("a"); !off {
		t.Fatal("a call that started earlier must not re-enable a rejected key")
	}
	b.Reset("a")
	if _, off := b.State("a"); off {
		t.Fatal("a reset must")
	}
}

func TestConcurrencyFollowsALoweredLimit(t *testing.T) {
	l := NewConcurrencyLimiter()
	ctx := context.Background()
	var releases []func()
	for range 3 {
		release, _ := l.Acquire(ctx, "k", 3)
		releases = append(releases, release)
	}
	granted := make(chan func(), 2)
	for range 2 {
		go func() {
			release, _ := l.Acquire(ctx, "k", 1)
			granted <- release
		}()
	}
	time.Sleep(20 * time.Millisecond)
	releases[0]()
	releases[1]()
	select {
	case <-granted:
		t.Fatal("two of three old calls ended, one still runs: the new limit of 1 is not free yet")
	case <-time.After(30 * time.Millisecond):
	}
	releases[2]()
	first := <-granted
	select {
	case <-granted:
		t.Fatal("only one waiter may run at a time")
	case <-time.After(30 * time.Millisecond):
	}
	first()
	(<-granted)()
	if l.Active("k") != 0 {
		t.Fatalf("active = %d", l.Active("k"))
	}
}
