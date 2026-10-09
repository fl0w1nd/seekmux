// Package core holds the provider-agnostic machinery: rate and concurrency
// limiting, fallback runners, call tracing and the HTTP helpers providers share.
package core

import (
	"context"
	"sync"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
)

// RateLimiter is a sliding-window limiter keyed by name. The limit is passed
// on every call, so a configuration change applies to the existing window
// instead of resetting it.
type RateLimiter struct {
	mu      sync.Mutex
	windows map[string][]time.Time
}

func NewRateLimiter() *RateLimiter {
	return &RateLimiter{windows: map[string][]time.Time{}}
}

// valid drops timestamps that left the window. The caller holds the lock.
func (l *RateLimiter) valid(key string, limit config.RateLimit, now time.Time) []time.Time {
	stamps := l.windows[key]
	i := 0
	for i < len(stamps) && now.Sub(stamps[i]) >= limit.Window {
		i++
	}
	stamps = stamps[i:]
	l.windows[key] = stamps
	return stamps
}

func (l *RateLimiter) check(key string, limit config.RateLimit, consume bool) (bool, time.Duration) {
	if limit.Requests <= 0 {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	stamps := l.valid(key, limit, now)
	if len(stamps) >= limit.Requests {
		// With a lowered limit the slot frees when enough old calls expire.
		blocking := stamps[len(stamps)-limit.Requests]
		return false, limit.Window - now.Sub(blocking)
	}
	if consume {
		l.windows[key] = append(stamps, now)
	}
	return true, 0
}

// Peek reports whether a slot is free without consuming it, and otherwise how
// long until one frees up.
func (l *RateLimiter) Peek(key string, limit config.RateLimit) (bool, time.Duration) {
	return l.check(key, limit, false)
}

// TryAcquire consumes a slot if one is free.
func (l *RateLimiter) TryAcquire(key string, limit config.RateLimit) (bool, time.Duration) {
	return l.check(key, limit, true)
}

// Acquire waits for a slot.
func (l *RateLimiter) Acquire(ctx context.Context, key string, limit config.RateLimit) error {
	for {
		ok, wait := l.TryAcquire(key, limit)
		if ok {
			return nil
		}
		if err := Sleep(ctx, wait); err != nil {
			return err
		}
	}
}

// Used returns how many slots of the window are taken.
func (l *RateLimiter) Used(key string, limit config.RateLimit) int {
	if limit.Requests <= 0 {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.valid(key, limit, time.Now()))
}

// Sleep waits for d or until ctx is done.
func Sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ConcurrencyLimiter caps in-flight calls per key. Like RateLimiter it takes
// the limit on every call.
type ConcurrencyLimiter struct {
	mu     sync.Mutex
	active map[string]int
	queues map[string][]chan struct{}
	limits map[string]int
}

func NewConcurrencyLimiter() *ConcurrencyLimiter {
	return &ConcurrencyLimiter{active: map[string]int{}, queues: map[string][]chan struct{}{}, limits: map[string]int{}}
}

// Acquire waits for a free slot and returns its release function. A limit of
// zero or less means unlimited.
func (l *ConcurrencyLimiter) Acquire(ctx context.Context, key string, limit int) (func(), error) {
	if limit <= 0 {
		return func() {}, nil
	}
	l.mu.Lock()
	// The latest caller knows the current limit; waiters are admitted by it.
	l.limits[key] = limit
	if l.active[key] < limit && len(l.queues[key]) == 0 {
		l.active[key]++
		l.mu.Unlock()
		return l.releaser(key), nil
	}
	ready := make(chan struct{})
	l.queues[key] = append(l.queues[key], ready)
	l.admit(key)
	l.mu.Unlock()

	select {
	case <-ready:
		return l.releaser(key), nil
	case <-ctx.Done():
		l.mu.Lock()
		defer l.mu.Unlock()
		queue := l.queues[key]
		for i, w := range queue {
			if w == ready {
				l.queues[key] = append(queue[:i], queue[i+1:]...)
				l.admit(key)
				return nil, ctx.Err()
			}
		}
		// The slot was granted while the context ended; give it back.
		l.release(key)
		return nil, ctx.Err()
	}
}

func (l *ConcurrencyLimiter) releaser(key string) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.release(key)
		})
	}
}

// release frees the caller's slot. The caller holds the lock.
func (l *ConcurrencyLimiter) release(key string) {
	l.active[key]--
	l.admit(key)
}

// admit grants slots to waiters while the limit allows, and forgets a key
// nobody uses. The caller holds the lock.
func (l *ConcurrencyLimiter) admit(key string) {
	for len(l.queues[key]) > 0 && l.active[key] < l.limits[key] {
		l.active[key]++
		close(l.queues[key][0])
		l.queues[key] = l.queues[key][1:]
	}
	if len(l.queues[key]) == 0 {
		delete(l.queues, key)
		if l.active[key] <= 0 {
			delete(l.active, key)
			delete(l.limits, key)
		}
	}
}

// Active returns the number of in-flight calls for key.
func (l *ConcurrencyLimiter) Active(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.active[key]
}
