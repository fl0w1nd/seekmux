package app

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"sync"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
)

// ErrCallStopped identifies a call canceled from the console.
var ErrCallStopped = errors.New("the call was stopped from the console")

// ActiveNode describes a running leaf in a live call.
type ActiveNode struct {
	ID      int    `json:"id"`
	Kind    string `json:"kind"`
	Name    string `json:"name,omitempty"`
	StartMs int64  `json:"start_ms"`
}

// LiveCall is the metadata and current activity of a registered call.
type LiveCall struct {
	CallID     string       `json:"call_id"`
	Tool       string       `json:"tool"`
	Source     string       `json:"source"`
	APIKeyID   int64        `json:"api_key_id"`
	APIKeyName string       `json:"api_key_name"`
	ClientIP   string       `json:"client_ip"`
	UserAgent  string       `json:"user_agent"`
	Summary    string       `json:"summary"`
	TaskID     string       `json:"task_id,omitempty"`
	StartedAt  int64        `json:"started_at"`
	Step       int          `json:"step,omitempty"`
	Active     []ActiveNode `json:"active"`
	Nodes      int          `json:"nodes"`
}

// LiveSnapshot lists running calls at the server time.
type LiveSnapshot struct {
	Now   int64      `json:"now"`
	Calls []LiveCall `json:"calls"`
}

// LiveEvent carries a call update, snapshot or completion.
type LiveEvent struct {
	Type     string
	Call     *LiveCall
	Snapshot *LiveSnapshot
	Done     *core.CallDone
}

type liveEntry struct {
	meta   LiveCall
	trace  *core.Trace
	cancel context.CancelCauseFunc
	done   *core.CallDone
	stop   chan struct{}
}

// Registry retains completed calls briefly and never waits for a subscriber.
type Registry struct {
	mu        sync.Mutex
	calls     map[string]*liveEntry
	subs      map[chan LiveEvent]struct{}
	retention time.Duration
	closed    bool
}

// NewRegistry retains finished calls for fifteen seconds.
func NewRegistry() *Registry {
	return &Registry{calls: map[string]*liveEntry{}, subs: map[chan LiveEvent]struct{}{}, retention: 15 * time.Second}
}

func (e *liveEntry) view() LiveCall {
	out := e.meta
	active, step, count := e.trace.Activity()
	out.Step, out.Nodes = step, count
	out.Active = make([]ActiveNode, 0, len(active))
	for _, n := range active {
		out.Active = append(out.Active, ActiveNode{n.ID, n.Kind, n.Name, n.StartMs})
	}
	return out
}

func (r *Registry) snapshotLocked() *LiveSnapshot {
	out := &LiveSnapshot{Now: time.Now().UnixMilli(), Calls: []LiveCall{}}
	for _, e := range r.calls {
		if e.done == nil {
			out.Calls = append(out.Calls, e.view())
		}
	}
	slices.SortFunc(out.Calls, func(a, b LiveCall) int {
		if a.StartedAt < b.StartedAt {
			return -1
		}
		if a.StartedAt > b.StartedAt {
			return 1
		}
		return 0
	})
	return out
}

// Snapshot lists running calls, oldest first.
func (r *Registry) Snapshot() *LiveSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.snapshotLocked()
}

func (r *Registry) publishLocked(event LiveEvent) {
	for ch := range r.subs {
		select {
		case ch <- event:
		default:
			for {
				select {
				case <-ch:
				default:
					goto drained
				}
			}
		drained:
			ch <- LiveEvent{Type: "snapshot", Snapshot: r.snapshotLocked()}
		}
	}
}

// Subscribe starts with a snapshot and replaces overflow with a fresh one.
func (r *Registry) Subscribe(buffer int) (<-chan LiveEvent, func()) {
	ch := make(chan LiveEvent, max(buffer, 1))
	r.mu.Lock()
	r.subs[ch] = struct{}{}
	ch <- LiveEvent{Type: "snapshot", Snapshot: r.snapshotLocked()}
	r.mu.Unlock()
	return ch, func() { r.mu.Lock(); delete(r.subs, ch); r.mu.Unlock() }
}

// Start registers a call and publishes changes in its activity.
func (r *Registry) Start(meta LiveCall, trace *core.Trace, cancel context.CancelCauseFunc) {
	e := &liveEntry{meta: meta, trace: trace, cancel: cancel, stop: make(chan struct{})}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		cancel(context.Canceled)
		return
	}
	r.calls[meta.CallID] = e
	initial := e.view()
	r.publishLocked(LiveEvent{Type: "call", Call: &initial})
	r.mu.Unlock()
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		prev := initial
		for {
			select {
			case <-e.stop:
				return
			case <-ticker.C:
				r.mu.Lock()
				current := e.view()
				if e.done == nil && (prev.Step != current.Step || !reflect.DeepEqual(prev.Active, current.Active)) {
					r.publishLocked(LiveEvent{Type: "call", Call: &current})
					prev = current
				}
				r.mu.Unlock()
			}
		}
	}()
}

// Finish publishes completion and schedules the retained call for removal.
func (r *Registry) Finish(id string, done core.CallDone) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.calls[id]
	if e == nil || e.done != nil {
		return
	}
	e.done = &done
	close(e.stop)
	e.trace.Complete(done)
	r.publishLocked(LiveEvent{Type: "done", Done: &done})
	time.AfterFunc(r.retention, func() { r.mu.Lock(); delete(r.calls, id); r.mu.Unlock() })
}

// Get returns a running or retained call and its trace.
func (r *Registry) Get(id string) (LiveCall, *core.Trace, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.calls[id]
	if e == nil {
		return LiveCall{}, nil, false
	}
	return e.view(), e.trace, true
}

// TaskCall returns the registered call id of a research task.
func (r *Registry) TaskCall(task string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, e := range r.calls {
		if e.meta.TaskID == task {
			return id
		}
	}
	return ""
}

// Cancel stops a running call from the console.
func (r *Registry) Cancel(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.calls[id]
	if e == nil || e.done != nil {
		return false
	}
	e.cancel(ErrCallStopped)
	return true
}

// Close stops running calls and rejects new registrations.
func (r *Registry) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	for _, e := range r.calls {
		if e.done == nil {
			e.cancel(context.Canceled)
		}
	}
}

type callStartKey struct{}

// WithCallStart observes registration after validation, before any upstream work.
func WithCallStart(ctx context.Context, fn func(*core.Trace)) context.Context {
	return context.WithValue(ctx, callStartKey{}, fn)
}

func (a *App) startCall(ctx context.Context, s *Snapshot, caller Caller, tool, summary, task string, args any, o Override) (context.Context, *core.Trace, context.CancelFunc) {
	ctx, trace := traced(ctx)
	ctx, cancel := context.WithCancelCause(ctx)
	attrs := map[string]any{"source": caller.Source, "api_key_name": caller.KeyName, "client_ip": caller.IP, "config_version": s.Version, "args": core.Object(args)}
	overrides := o.traceAttrs()
	if len(overrides) > 0 {
		attrs["overrides"] = overrides
	}
	if task != "" {
		attrs["task_id"] = task
	}
	policy := map[string]any{}
	for key, value := range s.policy {
		if key == "extract_models" {
			if tool == config.ToolFetch || tool == config.ToolResearch {
				policy[key] = value
			}
		} else if tool == config.ToolResearch {
			policy[key] = value
		}
	}
	if len(policy) > 0 {
		attrs["policy"] = policy
	}
	trace.Root(tool, attrs)
	a.Live.Start(LiveCall{CallID: trace.CallID, Tool: tool, Source: caller.Source, APIKeyID: caller.KeyID, APIKeyName: caller.KeyName, ClientIP: caller.IP, UserAgent: truncate(caller.UserAgent, 512), Summary: truncate(summary, 500), TaskID: task, StartedAt: trace.Start.UnixMilli()}, trace, cancel)
	if fn, ok := ctx.Value(callStartKey{}).(func(*core.Trace)); ok {
		fn(trace)
	}
	return ctx, trace, func() { cancel(nil) }
}

func (o Override) traceAttrs() map[string]any {
	if o.TraceAttrs != nil {
		return o.TraceAttrs
	}
	out := map[string]any{}
	if o.ExtractModel != "" {
		out["extract_model"] = o.ExtractModel
	}
	if o.ResearchModel != "" {
		out["research_model"] = o.ResearchModel
	}
	if o.Research != (ResearchOverride{}) {
		budget := core.Object(o.Research)
		for k, v := range budget {
			if v == "" || v == false || v == float64(0) {
				delete(budget, k)
			}
		}
		out["research"] = budget
	}
	if o.Route != nil {
		out["route"] = o.Route
	}
	if o.Pin != "" {
		out["pin"] = o.Pin
	}
	if o.NoCache {
		out["no_cache"] = true
	}
	return out
}
