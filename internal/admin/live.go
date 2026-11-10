package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/fl0w1nd/seekmux/internal/app"
	"github.com/fl0w1nd/seekmux/internal/core"
)

func startSSE(w http.ResponseWriter) (http.Flusher, bool) {
	f, ok := w.(http.Flusher)
	if !ok {
		writeError(w, 500, errors.New("streaming is not supported"))
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	return f, true
}

func sendSSE(w http.ResponseWriter, event string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if event != "" {
		if _, err = fmt.Fprintf(w, "event: %s\n", event); err != nil {
			return err
		}
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", data)
	return err
}

func doneValue(d *core.CallDone) map[string]any {
	return map[string]any{"status": d.Status, "duration_ms": d.DurationMs, "error": d.Error}
}

func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.app.Live.Snapshot())
}

func (s *Server) handleLiveCancel(w http.ResponseWriter, r *http.Request) {
	if !s.app.Live.Cancel(r.PathValue("call_id")) {
		writeError(w, 409, errors.New("the call is not running"))
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleGetLogByCall(w http.ResponseWriter, r *http.Request) {
	entry, found, err := s.app.Store.GetLogByCall(r.Context(), r.PathValue("call_id"))
	if err != nil {
		writeError(w, 500, err)
		return
	}
	if !found {
		writeError(w, 404, errors.New("log entry not found"))
		return
	}
	writeJSON(w, entry)
}

func (s *Server) handleLiveStream(w http.ResponseWriter, r *http.Request) {
	call, trace, found := s.app.Live.Get(r.PathValue("call_id"))
	if !found {
		writeError(w, 404, errors.New("call not found"))
		return
	}
	f, ok := startSSE(w)
	if !ok {
		return
	}
	events, unsubscribe := trace.Subscribe(128)
	defer unsubscribe()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case e := <-events:
			switch e.Type {
			case "snapshot":
				if current, _, ok := s.app.Live.Get(call.CallID); ok {
					call = current
				}
				if sendSSE(w, "snapshot", map[string]any{"now": time.Now().UnixMilli(), "call": call, "nodes": e.Snapshot.Nodes, "text": e.Snapshot.Text}) != nil {
					return
				}
				if e.Snapshot.Done != nil {
					_ = sendSSE(w, "done", doneValue(e.Snapshot.Done))
					f.Flush()
					return
				}
			case "node":
				if sendSSE(w, "node", e.Node) != nil {
					return
				}
			case "text":
				if sendSSE(w, "text", e.Text) != nil {
					return
				}
			case "done":
				_ = sendSSE(w, "done", doneValue(e.Done))
				f.Flush()
				return
			}
		case <-ticker.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
		case <-r.Context().Done():
			return
		}
		f.Flush()
	}
}

type playOutcome struct {
	value map[string]any
	err   error
}

type playSubscription struct {
	events <-chan core.TraceEvent
	cancel func()
}

// play starts the wire stream only after the app has accepted the arguments.
func play(w http.ResponseWriter, r *http.Request, run func(context.Context) (map[string]any, error)) {
	trace := core.NewTrace()
	ctx, cancel := context.WithCancel(core.WithTrace(r.Context(), trace))
	defer cancel()
	finish := func(out playOutcome) map[string]any {
		out.value["duration_ms"] = time.Since(trace.Start).Milliseconds()
		out.value["attempts"], out.value["call_id"], out.value["trace"] = trace.Attempts(), trace.CallID, trace.Nodes()
		return out.value
	}
	if !strings.Contains(r.Header.Get("Accept"), "application/x-ndjson") {
		value, err := run(ctx)
		if err != nil {
			writeError(w, 400, err)
			return
		}
		writeJSON(w, finish(playOutcome{value: value}))
		return
	}
	f, ok := w.(http.Flusher)
	if !ok {
		writeError(w, 500, errors.New("streaming is not supported"))
		return
	}
	started := make(chan playSubscription, 1)
	ctx = app.WithCallStart(ctx, func(t *core.Trace) { events, stop := t.Subscribe(256); started <- playSubscription{events, stop} })
	result := make(chan playOutcome, 1)
	go func() { value, err := run(ctx); result <- playOutcome{value, err} }()
	var sub playSubscription
	var ended *playOutcome
	select {
	case sub = <-started:
	case out := <-result:
		select {
		case sub = <-started:
			ended = &out
		default:
			writeError(w, 400, out.err)
			return
		}
	case <-ctx.Done():
		return
	}
	defer sub.cancel()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	encoder := json.NewEncoder(w)
	send := func(value any) bool {
		if encoder.Encode(value) != nil {
			return false
		}
		f.Flush()
		return true
	}
	if !send(map[string]any{"call_id": trace.CallID}) {
		return
	}
	textBytes := map[int]int{}
	emit := func(e core.TraceEvent) bool {
		switch e.Type {
		case "node":
			return send(map[string]any{"node": e.Node})
		case "text":
			textBytes[e.Text.Node] += len(e.Text.Delta)
			return send(map[string]any{"text": e.Text})
		case "snapshot":
			for _, n := range e.Snapshot.Nodes {
				if !send(map[string]any{"node": n}) {
					return false
				}
			}
			for _, n := range e.Snapshot.Nodes {
				text := e.Snapshot.Text[fmt.Sprint(n.ID)]
				if sent := textBytes[n.ID]; sent < len(text) {
					if !send(map[string]any{"text": core.TextDelta{Node: n.ID, Delta: text[sent:]}}) {
						return false
					}
					textBytes[n.ID] = len(text)
				}
			}
		}
		return true
	}
	for {
		if ended != nil {
			for {
				select {
				case e := <-sub.events:
					if !emit(e) {
						return
					}
				default:
					goto drained
				}
			}
		drained:
			if ended.err != nil {
				send(map[string]any{"error": ended.err.Error()})
			} else {
				send(map[string]any{"result": finish(*ended)})
			}
			return
		}
		select {
		case e := <-sub.events:
			if !emit(e) {
				return
			}
		case out := <-result:
			ended = &out
		case <-ctx.Done():
			return
		}
	}
}

func readPlay(w http.ResponseWriter, r *http.Request, body any, modelKey string) (map[string]any, bool) {
	var raw json.RawMessage
	if !readJSON(w, r, &raw) {
		return nil, false
	}
	if err := json.Unmarshal(raw, body); err != nil {
		writeError(w, 400, fmt.Errorf("invalid request body: %w", err))
		return nil, false
	}
	var values map[string]any
	_ = json.Unmarshal(raw, &values)
	attrs := map[string]any{}
	for _, key := range []string{"route", "pin", "no_cache", "extract_model", "research_model", "research"} {
		if v, ok := values[key]; ok && v != nil {
			attrs[key] = v
		}
	}
	if v, ok := values["model"]; ok && modelKey != "" {
		attrs[modelKey] = v
	}
	if v, ok := values["budget"]; ok {
		attrs["research"] = v
	}
	return attrs, true
}
