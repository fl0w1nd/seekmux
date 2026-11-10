package core

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

func untilMillis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func runSpan(ctx context.Context, name string, opt RunOptions) (context.Context, *Span) {
	if TraceFrom(ctx) == nil {
		return ctx, nil
	}
	attrs := map[string]any{"kind": opt.Kind, "target": opt.Target, "timeout_ms": opt.Timeout.Milliseconds(), "rate_strategy": "wait"}
	if opt.Strategy != "" {
		attrs["rate_strategy"] = opt.Strategy
	}
	if name == "hedged" {
		attrs["slow_threshold_ms"] = opt.SlowThreshold.Milliseconds()
		attrs["rate_strategy"] = StrategyFallback
	}
	if opt.GoneAfter > 0 {
		attrs["gone_after"] = opt.GoneAfter
	}
	return StartSpan(ctx, "run", name, attrs)
}

func attemptSpan[In, Out any](ctx context.Context, p Provider[In, Out], opt RunOptions) (context.Context, *Span) {
	if opt.Untraced || TraceFrom(ctx) == nil {
		return ctx, nil
	}
	attrs := map[string]any{"kind": opt.Kind, "target": opt.Target, "trigger": opt.trigger}
	if opt.try > 0 {
		attrs["try"] = opt.try
	}
	if len(p.Options) > 0 {
		attrs["options"] = p.Options
	}
	if len(p.ExtraBody) > 0 {
		attrs["extra_body"] = p.ExtraBody
	}
	return StartSpan(ctx, "attempt", p.Name, attrs)
}

func endAttempt(s *Span, err error) {
	if err != nil {
		class := ClassProvider
		var h *HTTPError
		var target *TargetError
		if errors.As(err, &h) {
			class = h.Kind()
		} else if errors.As(err, &target) {
			class = ClassTarget
		}
		if !errors.Is(err, context.Canceled) {
			s.Set(map[string]any{"error_class": string(class)})
		}
	}
	s.End(err)
}

func noteLimited(ctx context.Context, opt RunOptions, provider string, wait time.Duration) {
	t := TraceFrom(ctx)
	t.Limited(opt.Kind, provider, opt.Target, wait)
	_, s := StartSpan(ctx, "attempt", provider, map[string]any{"kind": opt.Kind, "target": opt.Target, "wait_ms": wait.Milliseconds()})
	s.EndStatus("limited", errors.New("rate limit reached, next slot in "+wait.Round(time.Millisecond).String()))
}

// Wait exposes a wait only once it lasts long enough to be useful.
func Wait(ctx context.Context, name, provider string, planned time.Duration, fn func() error) error {
	if TraceFrom(ctx) == nil {
		return fn()
	}
	var mu sync.Mutex
	var span *Span
	finished := false
	timer := time.AfterFunc(5*time.Millisecond, func() {
		mu.Lock()
		defer mu.Unlock()
		if finished {
			return
		}
		attrs := map[string]any{"provider": strings.TrimPrefix(provider, "llm:")}
		if planned > 0 {
			attrs["wait_ms"] = planned.Milliseconds()
		}
		_, span = StartSpan(ctx, "wait", name, attrs)
	})
	err := fn()
	mu.Lock()
	finished = true
	timer.Stop()
	span.End(err)
	mu.Unlock()
	return err
}

// Rename updates the node name and publishes it.
func (s *Span) Rename(name string) {
	if s == nil {
		return
	}
	t := s.trace
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sealed {
		return
	}
	t.nodes[s.id-1].Name = name
	t.nodeLocked(t.nodes[s.id-1])
}
