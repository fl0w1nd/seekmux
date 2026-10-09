package core

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Attempt is one upstream call made while serving a tool call.
type Attempt struct {
	Kind       string `json:"kind"`
	Provider   string `json:"provider"`
	Target     string `json:"target,omitempty"`
	Status     string `json:"status"`
	StartMs    int64  `json:"start_ms"`
	DurationMs int64  `json:"duration_ms"`
	HTTPStatus int    `json:"http_status,omitempty"`
	Error      string `json:"error,omitempty"`
}

const (
	AttemptOK       = "ok"
	AttemptError    = "error"
	AttemptCanceled = "canceled"
	AttemptCached   = "cached"
	// AttemptSkipped is a provider the circuit breaker had switched off.
	AttemptSkipped = "skipped"
)

// Usage is the token usage of the LLM calls made for a tool call. InputTokens
// is everything the model was sent; CacheReadTokens and CacheWriteTokens are
// the parts of it served from, and written to, the provider's prompt cache.
type Usage struct {
	InputTokens      int64 `json:"input_tokens"`
	OutputTokens     int64 `json:"output_tokens"`
	CacheReadTokens  int64 `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens int64 `json:"cache_write_tokens,omitempty"`
}

func (u Usage) Add(o Usage) Usage {
	return Usage{
		InputTokens: u.InputTokens + o.InputTokens, OutputTokens: u.OutputTokens + o.OutputTokens,
		CacheReadTokens: u.CacheReadTokens + o.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens + o.CacheWriteTokens,
	}
}

// Trace collects the attempts and token usage of one tool call so the request
// log can show how the answer was produced.
type Trace struct {
	Start time.Time

	mu       sync.Mutex
	attempts []Attempt
	usage    Usage
}

func NewTrace() *Trace { return &Trace{Start: time.Now()} }

type traceKey struct{}

func WithTrace(ctx context.Context, t *Trace) context.Context {
	return context.WithValue(ctx, traceKey{}, t)
}

// TraceFrom returns the trace of ctx, or nil. All Trace methods accept nil.
func TraceFrom(ctx context.Context) *Trace {
	t, _ := ctx.Value(traceKey{}).(*Trace)
	return t
}

// Begin starts timing an attempt and returns the function that records it.
func (t *Trace) Begin(kind, provider, target string) func(err error) {
	started := time.Now()
	return func(err error) { t.Record(kind, provider, target, started, err) }
}

// Record adds an attempt that started at the given time and just ended. An
// attempt ended by its context lost a race or was cut by the deadline.
func (t *Trace) Record(kind, provider, target string, started time.Time, err error) {
	if t == nil {
		return
	}
	a := Attempt{
		Kind: kind, Provider: provider, Target: target, Status: AttemptOK,
		StartMs:    started.Sub(t.Start).Milliseconds(),
		DurationMs: time.Since(started).Milliseconds(),
	}
	if err != nil {
		a.Status, a.Error, a.HTTPStatus = AttemptError, err.Error(), HTTPStatus(err)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			a.Status = AttemptCanceled
		}
	}
	t.add(a)
}

// Note records an attempt that did not involve an upstream call.
func (t *Trace) Note(kind, provider, target, status string) {
	if t == nil {
		return
	}
	t.add(Attempt{Kind: kind, Provider: provider, Target: target, Status: status, StartMs: time.Since(t.Start).Milliseconds()})
}

// Skip records a provider that was passed over without being called.
func (t *Trace) Skip(kind, provider, target, reason string) {
	if t == nil {
		return
	}
	t.add(Attempt{Kind: kind, Provider: provider, Target: target, Status: AttemptSkipped, Error: reason, StartMs: time.Since(t.Start).Milliseconds()})
}

func (t *Trace) add(a Attempt) {
	t.mu.Lock()
	t.attempts = append(t.attempts, a)
	t.mu.Unlock()
}

func (t *Trace) AddUsage(u Usage) {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.usage = t.usage.Add(u)
	t.mu.Unlock()
}

func (t *Trace) Attempts() []Attempt {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]Attempt(nil), t.attempts...)
}

func (t *Trace) Usage() Usage {
	if t == nil {
		return Usage{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.usage
}
