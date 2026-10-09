package core

import (
	"context"
	"errors"
	"net"
	"sync"
	"time"
)

// BreakerSettings is the one policy shared by every provider and model.
type BreakerSettings struct {
	Enabled bool
	// Failures in a row within Window disable a key for Cooldown.
	Failures int
	Window   time.Duration
	Cooldown time.Duration
}

// Breaker temporarily disables a provider or model that keeps failing, so
// calls go straight to the next one instead of each finding out for itself.
// After the cooldown the key is on probation: one more failure disables it
// again at once, a success clears it.
type Breaker struct {
	mu       sync.Mutex
	settings BreakerSettings
	states   map[string]*breakerState
}

type breakerState struct {
	failures []time.Time
	tripped  bool
	// until is when it may be tried again; zero means not before someone
	// re-enables it.
	until time.Time
	// cooldown is how long one more failure on probation disables it again.
	cooldown time.Duration
	reason   Class
	detail   string
}

// Trip describes something the breaker has switched off.
type Trip struct {
	// Reason is ClassProvider for repeated failures, or the account problem.
	Reason Class
	// Until is when it is tried again; zero means it stays off until it is
	// re-enabled by hand or the configuration is saved.
	Until time.Time
	// Detail is what the upstream said, for account problems.
	Detail string
}

func NewBreaker() *Breaker { return &Breaker{states: map[string]*breakerState{}} }

// Configure replaces the policy and re-enables everything: it runs when the
// configuration is saved, which is also how a rejected key gets fixed.
func (b *Breaker) Configure(s BreakerSettings) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.settings = s
	clear(b.states)
}

// State reports whether key is switched off right now, and the details.
func (b *Breaker) State(key string) (Trip, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.states[key]
	if s == nil || !s.tripped || (!s.until.IsZero() && !time.Now().Before(s.until)) {
		return Trip{}, false
	}
	return Trip{Reason: s.reason, Until: s.until, Detail: s.detail}, true
}

// Disable switches key off at once, for a rejected key or spent credits:
// asking again changes nothing until someone fixes the account. It stays off
// until re-enabled, unless the provider said when it recovers (after > 0).
func (b *Breaker) Disable(key string, reason Class, detail string, after time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.settings.Enabled {
		return
	}
	state := &breakerState{tripped: true, reason: reason, detail: detail}
	if after > 0 {
		state.until = time.Now().Add(after)
	}
	b.states[key] = state
}

// Success clears the failure record of key.
func (b *Breaker) Success(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s := b.states[key]; s != nil && s.tripped && s.reason != ClassProvider && (s.until.IsZero() || time.Now().Before(s.until)) {
		// A call that started before the key was rejected proves nothing.
		return
	}
	delete(b.states, key)
}

// Failure counts a failure of key and disables it when the policy says so.
func (b *Breaker) Failure(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.settings.Enabled {
		return
	}
	s := b.states[key]
	if s == nil {
		s = &breakerState{}
		b.states[key] = s
	}
	now := time.Now()
	if s.tripped {
		// Failing on probation, or a call that was already under way.
		if !s.until.IsZero() {
			s.until = now.Add(max(s.cooldown, b.settings.Cooldown))
		}
		return
	}
	recent := s.failures[:0]
	for _, at := range s.failures {
		if now.Sub(at) < b.settings.Window {
			recent = append(recent, at)
		}
	}
	s.failures = append(recent, now)
	if len(s.failures) >= b.settings.Failures {
		s.tripped, s.until, s.failures = true, now.Add(b.settings.Cooldown), nil
		s.cooldown, s.reason = b.settings.Cooldown, ClassProvider
	}
}

// Reset re-enables key.
func (b *Breaker) Reset(key string) {
	b.mu.Lock()
	delete(b.states, key)
	b.mu.Unlock()
}

// Tripping reports whether err says something about the health of the
// upstream, as opposed to the request or the page asked for: it was
// unreachable, timed out, was overloaded or kept limiting us.
func Tripping(err error) bool {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		kind := httpErr.Kind()
		return kind == ClassProvider || kind == ClassRateLimit
	}
	var timeout *TimeoutError
	var netErr net.Error
	return errors.As(err, &timeout) || errors.As(err, &netErr) ||
		errors.Is(err, ErrUnresponsive) || errors.Is(err, context.DeadlineExceeded)
}

// accountProblem reports an error that needs someone to fix the account: a
// rejected key or exhausted credits.
func accountProblem(err error) (*HTTPError, bool) {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		kind := httpErr.Kind()
		return httpErr, kind == ClassAuth || kind == ClassQuota
	}
	return nil, false
}

// ErrUnresponsive marks an upstream that accepted a request and then did not
// answer in time.
var ErrUnresponsive = errors.New("upstream did not respond in time")
