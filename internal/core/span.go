package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const maxTraceNodes = 4000

// Node is an upsertable decision or operation in a call.
type Node struct {
	ID         int            `json:"id"`
	Parent     int            `json:"parent,omitempty"`
	Kind       string         `json:"kind"`
	Name       string         `json:"name,omitempty"`
	Status     string         `json:"status"`
	StartMs    int64          `json:"start_ms"`
	DurationMs int64          `json:"duration_ms,omitempty"`
	HTTPStatus int            `json:"http_status,omitempty"`
	Error      string         `json:"error,omitempty"`
	Attrs      map[string]any `json:"attrs,omitempty"`
}

// TextDelta is a live text fragment outside the stored tree.
type TextDelta struct {
	Node  int    `json:"node"`
	Delta string `json:"delta"`
}

// CallDone describes a completed call.
type CallDone struct {
	CallID     string `json:"call_id,omitempty"`
	Status     string `json:"status"`
	DurationMs int64  `json:"duration_ms"`
	Error      string `json:"error"`
}

// TraceSnapshot is an immutable tree and text copy for a subscriber.
type TraceSnapshot struct {
	Nodes []Node
	Text  map[string]string
	Done  *CallDone
}

// TraceEvent carries an immutable node, text delta or lifecycle update.
type TraceEvent struct {
	Type     string
	Node     *Node
	Text     *TextDelta
	Snapshot *TraceSnapshot
	Done     *CallDone
}

type parentKey struct{}

// Span updates a node in its trace.
type Span struct {
	trace *Trace
	id    int
}

func token() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return "c_" + hex.EncodeToString(b[:])
}

// Object gives arguments their JSON field names before they enter attributes.
func Object(v any) map[string]any {
	b, _ := json.Marshal(v)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

func cutText(s string, limit int, suffix string) string {
	if len(s) <= limit {
		return s
	}
	end := limit - len(suffix)
	for end > 0 && !utf8.RuneStart(s[end]) {
		end--
	}
	return s[:end] + suffix
}

func copyValue(v any) any {
	switch x := v.(type) {
	case string:
		return cutText(x, 2000, "…")
	case map[string]any:
		return copyAttrs(x)
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = copyValue(v)
		}
		return out
	case nil, bool, int, int64, float64:
		return v
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return nil
		}
		var out any
		if json.Unmarshal(b, &out) != nil {
			return nil
		}
		return copyValue(out)
	}
}

func copyAttrs(attrs map[string]any) map[string]any {
	if len(attrs) == 0 {
		return nil
	}
	out := make(map[string]any, len(attrs))
	for k, v := range attrs {
		if secretAttr(k) {
			continue
		}
		out[k] = copyValue(v)
	}
	return out
}

func copyNode(n Node) Node { n.Attrs = copyAttrs(n.Attrs); return n }

// StartSpan carries its parent even across provider and agent goroutines.
func StartSpan(ctx context.Context, kind, name string, attrs map[string]any) (context.Context, *Span) {
	t := TraceFrom(ctx)
	if t == nil {
		return ctx, nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sealed {
		return ctx, nil
	}
	if len(t.nodes) >= maxTraceNodes {
		root := &t.nodes[0]
		if root.Attrs == nil {
			root.Attrs = map[string]any{}
		}
		if root.Attrs["truncated"] != true {
			root.Attrs["truncated"] = true
			t.nodeLocked(*root)
		}
		return ctx, nil
	}
	parent, _ := ctx.Value(parentKey{}).(int)
	if parent <= 0 || parent > len(t.nodes) {
		parent = 1
	}
	n := Node{ID: len(t.nodes) + 1, Parent: parent, Kind: kind, Name: name, Status: "running", StartMs: time.Since(t.Start).Milliseconds(), Attrs: copyAttrs(attrs)}
	t.nodes = append(t.nodes, n)
	t.nodeLocked(n)
	return context.WithValue(ctx, parentKey{}, n.ID), &Span{t, n.ID}
}

// Mark records an instant decision.
func Mark(ctx context.Context, kind, name, status string, attrs map[string]any) {
	_, s := StartSpan(ctx, kind, name, attrs)
	s.endInstant(status, nil)
}

// MarkResult records the tool outcome, giving cancellation precedence over errors.
func MarkResult(ctx context.Context, err error, attrs map[string]any) {
	if TraceFrom(ctx) == nil {
		return
	}
	status := "ok"
	if err != nil {
		status = "error"
	}
	if ctx.Err() != nil {
		status, err = "canceled", context.Cause(ctx)
	}
	_, s := StartSpan(ctx, "result", "", attrs)
	s.endInstant(status, err)
}

func (s *Span) endInstant(status string, err error) {
	if s == nil {
		return
	}
	t := s.trace
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sealed {
		return
	}
	n := &t.nodes[s.id-1]
	n.Status = status
	n.DurationMs = 0
	if err != nil {
		n.Error = err.Error()
	}
	t.nodeLocked(*n)
}

// CurrentSpan returns the context parent, or the root when none is set.
func CurrentSpan(ctx context.Context) *Span {
	t := TraceFrom(ctx)
	if t == nil {
		return nil
	}
	id, _ := ctx.Value(parentKey{}).(int)
	if id == 0 {
		id = 1
	}
	return &Span{t, id}
}

// ID returns the node id, or zero without a trace.
func (s *Span) ID() int {
	if s == nil {
		return 0
	}
	return s.id
}

// Set merges attributes and publishes the updated node.
func (s *Span) Set(attrs map[string]any) {
	if s == nil || len(attrs) == 0 {
		return
	}
	s.trace.mu.Lock()
	defer s.trace.mu.Unlock()
	if s.trace.sealed {
		return
	}
	n := &s.trace.nodes[s.id-1]
	if n.Attrs == nil {
		n.Attrs = map[string]any{}
	}
	for k, v := range attrs {
		if secretAttr(k) {
			continue
		}
		n.Attrs[k] = copyValue(v)
	}
	s.trace.nodeLocked(*n)
}

// End closes the node with the status of err.
func (s *Span) End(err error) {
	status := "ok"
	if err != nil {
		status = "error"
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			status = "canceled"
		}
	}
	s.EndStatus(status, err)
}

// EndStatus closes the node with an explicit status.
func (s *Span) EndStatus(status string, err error) {
	if s == nil {
		return
	}
	t := s.trace
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sealed {
		return
	}
	n := &t.nodes[s.id-1]
	if n.Status != "running" {
		return
	}
	n.Status = status
	n.DurationMs = max(0, time.Since(t.Start).Milliseconds()-n.StartMs)
	if err != nil {
		n.Error, n.HTTPStatus = err.Error(), HTTPStatus(err)
	}
	t.nodeLocked(*n)
}

// Text publishes a delta and retains bounded text for late subscribers.
func (s *Span) Text(delta string) {
	if s == nil || delta == "" {
		return
	}
	t := s.trace
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sealed {
		return
	}
	if t.text == nil {
		t.text = map[string]string{}
	}
	key := strconv.Itoa(s.id)
	old := t.text[key]
	if len(old) < 64<<10 {
		t.text[key] = old + cutText(delta, (64<<10)-len(old), "")
	}
	t.publishLocked(TraceEvent{Type: "text", Text: &TextDelta{Node: s.id, Delta: delta}})
}

// Root sets the call name and metadata.
func (t *Trace) Root(name string, attrs map[string]any) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sealed {
		return
	}
	t.nodes[0].Name, t.nodes[0].Attrs = name, copyAttrs(attrs)
	t.nodeLocked(t.nodes[0])
}

// Nodes returns an immutable copy of the tree.
func (t *Trace) Nodes() []Node {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshotLocked().Nodes
}

func (t *Trace) snapshotLocked() *TraceSnapshot {
	out := &TraceSnapshot{Nodes: make([]Node, len(t.nodes)), Text: map[string]string{}, Done: t.done}
	for i, n := range t.nodes {
		out.Nodes[i] = copyNode(n)
	}
	for k, v := range t.text {
		out.Text[k] = v
	}
	return out
}

func (t *Trace) nodeLocked(n Node) {
	if len(t.subs) == 0 {
		return
	}
	n = copyNode(n)
	t.publishLocked(TraceEvent{Type: "node", Node: &n})
}

func (t *Trace) publishLocked(e TraceEvent) {
	for ch := range t.subs {
		select {
		case ch <- e:
		default:
			for {
				select {
				case <-ch:
				default:
					goto drained
				}
			}
		drained:
			ch <- TraceEvent{Type: "snapshot", Snapshot: t.snapshotLocked()}
		}
	}
}

// Subscribe starts with an atomic snapshot; overflow replaces the backlog.
func (t *Trace) Subscribe(buffer int) (<-chan TraceEvent, func()) {
	ch := make(chan TraceEvent, max(buffer, 1))
	t.mu.Lock()
	if t.subs == nil {
		t.subs = map[chan TraceEvent]struct{}{}
	}
	t.subs[ch] = struct{}{}
	ch <- TraceEvent{Type: "snapshot", Snapshot: t.snapshotLocked()}
	t.mu.Unlock()
	return ch, func() { t.mu.Lock(); delete(t.subs, ch); t.mu.Unlock() }
}

// Seal freezes the log's view, including hedges whose goroutines outlive it.
func (t *Trace) Seal(status, message string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sealed {
		return
	}
	elapsed := time.Since(t.Start).Milliseconds()
	for i := len(t.nodes) - 1; i >= 0; i-- {
		n := &t.nodes[i]
		if n.Status != "running" {
			continue
		}
		n.Status, n.DurationMs = "canceled", max(0, elapsed-n.StartMs)
		if i == 0 {
			n.Status, n.Error = status, message
		}
		t.nodeLocked(*n)
	}
	t.sealed = true
}

// Complete publishes the final call outcome once.
func (t *Trace) Complete(done CallDone) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done != nil {
		return
	}
	t.done = &done
	t.publishLocked(TraceEvent{Type: "done", Done: &done})
}

// Activity returns running leaves and the current research step.
func (t *Trace) Activity() (active []Node, step, count int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	count = len(t.nodes)
	parents := map[int]bool{}
	for _, n := range t.nodes {
		if n.Status == "running" {
			parents[n.Parent] = true
			if n.Kind == "step" {
				step, _ = strconv.Atoi(n.Name)
			}
		}
	}
	active = []Node{}
	for _, n := range t.nodes {
		if n.Status == "running" && !parents[n.ID] && len(active) < 4 {
			n.Attrs = nil
			active = append(active, n)
		}
	}
	return
}

func secretAttr(key string) bool {
	switch strings.ReplaceAll(strings.ToLower(key), "-", "_") {
	case "api_key", "apikey", "token", "access_token", "refresh_token", "worker_token", "authorization", "proxy_authorization", "x_api_key", "x_subscription_token":
		return true
	}
	return false
}

// UsageAttrs gives token counts their trace field names.
func UsageAttrs(u Usage) map[string]any {
	return map[string]any{"input_tokens": u.InputTokens, "output_tokens": u.OutputTokens, "cache_read_tokens": u.CacheReadTokens, "cache_write_tokens": u.CacheWriteTokens}
}
