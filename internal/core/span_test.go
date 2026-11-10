package core

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/fl0w1nd/seekmux/internal/config"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func TestTraceTree(t *testing.T) {
	for _, tc := range []struct {
		name string
		run  func(*testing.T)
	}{
		{"context parents", func(t *testing.T) {
			trace := NewTrace()
			ctx := WithTrace(context.Background(), trace)
			parent, span := StartSpan(ctx, "tool", "fetch", nil)
			child, attempt := StartSpan(parent, "attempt", "fake", nil)
			Mark(child, "page", "", "ok", map[string]any{"bytes": 3})
			attempt.Set(map[string]any{"bytes": 3})
			attempt.End(nil)
			span.End(nil)
			nodes := trace.Nodes()
			if len(nodes) != 4 || nodes[1].Parent != 1 || nodes[2].Parent != 2 || nodes[3].Parent != 3 || nodes[3].DurationMs != 0 {
				t.Fatalf("tree=%+v", nodes)
			}
			nodes[2].Attrs["bytes"] = 100
			if trace.Nodes()[2].Attrs["bytes"] != 3 {
				t.Fatal("snapshot changed trace")
			}
		}},
		{"seal", func(t *testing.T) {
			trace := NewTrace()
			ctx := WithTrace(context.Background(), trace)
			_, s := StartSpan(ctx, "attempt", "late", nil)
			trace.Record("fetch", "fake", "url", trace.Start, nil)
			trace.Seal("error", "failed")
			before, _ := json.Marshal(trace.Nodes())
			s.Set(map[string]any{"late": true})
			s.Text("late")
			s.End(nil)
			Mark(ctx, "late", "", "ok", nil)
			trace.Record("fetch", "late", "url", trace.Start, nil)
			trace.AddUsage("late", Usage{InputTokens: 1})
			after, _ := json.Marshal(trace.Nodes())
			if string(before) != string(after) || len(trace.Attempts()) != 1 || trace.Usage().InputTokens != 0 {
				t.Fatal("sealed trace changed")
			}
			if nodes := trace.Nodes(); nodes[0].Status != "error" || nodes[0].Error != "failed" || nodes[1].Status != "canceled" {
				t.Fatalf("nodes=%+v", nodes)
			}
		}},
		{"bounds", func(t *testing.T) {
			trace := NewTrace()
			ctx := WithTrace(context.Background(), trace)
			Mark(ctx, "test", "", "ok", map[string]any{"nested": map[string]any{"long": strings.Repeat("界", 1000)}})
			value := trace.Nodes()[1].Attrs["nested"].(map[string]any)["long"].(string)
			if len(value) > 2000 || !utf8.ValidString(value) || !strings.HasSuffix(value, "…") {
				t.Fatalf("string length=%d", len(value))
			}
			for range 4100 {
				Mark(ctx, "test", "", "ok", nil)
			}
			if nodes := trace.Nodes(); len(nodes) != 4000 || nodes[0].Attrs["truncated"] != true {
				t.Fatalf("nodes=%d root=%+v", len(nodes), nodes[0])
			}
		}},
		{"events", func(t *testing.T) {
			trace := NewTrace()
			ctx := WithTrace(context.Background(), trace)
			events, stop := trace.Subscribe(16)
			defer stop()
			if e := <-events; e.Type != "snapshot" || len(e.Snapshot.Nodes) != 1 {
				t.Fatal("no initial snapshot")
			}
			_, s := StartSpan(ctx, "llm", "fake", map[string]any{"try": 1})
			s.Set(map[string]any{"usage": Usage{InputTokens: 4}})
			s.Text("hello")
			s.End(errors.New("failed"))
			want := []string{"node", "node", "text", "node"}
			for _, kind := range want {
				e := <-events
				if e.Type != kind {
					t.Fatalf("event=%+v want=%s", e, kind)
				}
				if kind == "node" && e.Node.ID != 2 {
					t.Fatalf("node=%+v", e.Node)
				}
			}
		}},
		{"overflow and text", func(t *testing.T) {
			trace := NewTrace()
			ctx := WithTrace(context.Background(), trace)
			events, stop := trace.Subscribe(1)
			defer stop()
			_, s := StartSpan(ctx, "llm", "fake", nil)
			s.Text(strings.Repeat("a", 70<<10))
			s.Set(map[string]any{"last": true})
			e := <-events
			if e.Type != "snapshot" || len(e.Snapshot.Nodes) != 2 || len(e.Snapshot.Text["2"]) != 64<<10 {
				t.Fatalf("overflow=%s", e.Type)
			}
			trace.Seal("ok", "")
			trace.Complete(CallDone{Status: "ok"})
			e = <-events
			if e.Type != "snapshot" || e.Snapshot.Done == nil {
				t.Fatal("overflow lost done")
			}
		}},
		{"no trace", func(t *testing.T) {
			ctx := context.Background()
			out, s := StartSpan(ctx, "test", "", nil)
			s.Set(map[string]any{"x": 1})
			s.Text("text")
			s.End(nil)
			Mark(ctx, "test", "", "ok", nil)
			if out != ctx || s != nil {
				t.Fatal("untraced context changed")
			}
		}},
	} {
		t.Run(tc.name, tc.run)
	}
}

func TestConcurrentTraceEvents(t *testing.T) {
	trace := NewTrace()
	ctx := WithTrace(context.Background(), trace)
	events, stop := trace.Subscribe(2)
	defer stop()
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 100 {
				_, s := StartSpan(ctx, "attempt", "parallel", nil)
				s.Set(map[string]any{"value": "x"})
				s.Text("x")
				s.End(nil)
			}
		})
	}
	wg.Wait()
	trace.Seal("ok", "")
	var event TraceEvent
	for {
		select {
		case event = <-events:
		default:
			goto drained
		}
	}
drained:
	if event.Type != "node" && event.Type != "snapshot" {
		t.Fatalf("last=%+v", event)
	}
	for _, n := range trace.Nodes() {
		if n.Status == "running" {
			t.Fatalf("running=%+v", n)
		}
	}
}

func TestRunnerTreesPreserveAttempts(t *testing.T) {
	for _, hedged := range []bool{false, true} {
		name := "fallback"
		if hedged {
			name = "hedged"
		}
		t.Run(name, func(t *testing.T) {
			trace := NewTrace()
			ctx := WithTrace(context.Background(), trace)
			providers := []Provider[string, string]{provider("a", config.RateLimit{}, fail(&HTTPError{Provider: "A", StatusCode: 500})), provider("b", config.RateLimit{}, ok("answer"))}
			opt := RunOptions{Kind: "fetch", Target: "https://example.test", Timeout: time.Second, SlowThreshold: time.Second}
			var winner string
			var err error
			if hedged {
				_, winner, err = RunHedged(ctx, NewLimits(), providers, "", opt)
			} else {
				_, winner, err = RunFallback(ctx, NewLimits(), providers, "", opt)
			}
			if err != nil || winner != "b" {
				t.Fatalf("winner=%s err=%v", winner, err)
			}
			attempts := trace.Attempts()
			if len(attempts) != 2 {
				t.Fatalf("attempts=%+v", attempts)
			}
			for i, want := range []struct {
				provider, status string
				http             int
			}{{"a", "error", 500}, {"b", "ok", 0}} {
				a := attempts[i]
				if a.Kind != "fetch" || a.Provider != want.provider || a.Target != opt.Target || a.Status != want.status || a.HTTPStatus != want.http || a.StartMs < 0 || a.DurationMs < 0 {
					t.Fatalf("attempt=%+v", a)
				}
			}
			nodes := trace.Nodes()
			if len(nodes) != 4 || nodes[1].Kind != "run" || nodes[1].Name != name || nodes[1].Attrs["winner"] != "b" {
				t.Fatalf("tree=%+v", nodes)
			}
			for i, trigger := range []string{"first", "after_failure"} {
				n := nodes[i+2]
				if n.Parent != 2 || n.Kind != "attempt" || n.Name != attempts[i].Provider || n.Status != attempts[i].Status || n.Attrs["trigger"] != trigger {
					t.Fatalf("node=%+v", n)
				}
			}
			if !reflect.DeepEqual(attempts, trace.Attempts()) {
				t.Fatal("tree reads changed attempts")
			}
		})
	}
}

func TestRunnerWaitAndHedgeReasons(t *testing.T) {
	for _, name := range []string{"slow hedge", "rate slot", "single retry", "untraced notes"} {
		t.Run(name, func(t *testing.T) {
			trace := NewTrace()
			ctx := WithTrace(context.Background(), trace)
			limits := NewLimits()
			opt := RunOptions{Kind: "fetch", Timeout: time.Second, SlowThreshold: 10 * time.Millisecond, Strategy: StrategyFallback}
			providers := []Provider[string, string]{provider("a", config.RateLimit{}, ok("answer"))}
			switch name {
			case "slow hedge":
				providers = []Provider[string, string]{provider("a", config.RateLimit{}, slow(time.Second, "slow")), provider("b", config.RateLimit{}, ok("answer"))}
				_, winner, err := RunHedged(ctx, limits, providers, "", opt)
				if err != nil || winner != "b" {
					t.Fatalf("winner=%s err=%v", winner, err)
				}
				found := false
				for _, n := range trace.Nodes() {
					if n.Kind == "attempt" && n.Name == "b" {
						found = n.Attrs["trigger"] == "slow"
					}
				}
				if !found {
					t.Fatal("slow hedge reason missing")
				}
				attempts := trace.Attempts()
				if len(attempts) != 2 || attempts[0].Provider != "b" || attempts[0].Status != "ok" || attempts[1].Provider != "a" || attempts[1].Status != "canceled" {
					t.Fatalf("attempts=%+v", attempts)
				}
			case "rate slot":
				rate := config.RateLimit{Requests: 1, Window: 30 * time.Millisecond}
				providers[0].RateLimit = rate
				limits.Rate.TryAcquire("a", rate)
				_, _, err := RunFallback(ctx, limits, providers, "", opt)
				if err != nil {
					t.Fatal(err)
				}
				limited, waited, started := false, false, false
				for _, n := range trace.Nodes() {
					limited = limited || (n.Kind == "attempt" && n.Status == "limited" && n.Attrs["wait_ms"] != nil)
					waited = waited || (n.Kind == "wait" && n.Name == "rate_limit" && n.Status == "ok" && n.Attrs["provider"] == "a")
					started = started || (n.Kind == "attempt" && n.Status == "ok" && n.Attrs["trigger"] == "slot_freed")
				}
				if !limited || !waited || !started {
					t.Fatalf("tree=%+v", trace.Nodes())
				}
			case "single retry":
				var calls atomic.Int32
				providers[0].Execute = func(context.Context, string) (string, error) {
					if calls.Add(1) == 1 {
						return "", &HTTPError{StatusCode: 429, HasRetry: true, RetryAfter: 10 * time.Millisecond}
					}
					return "answer", nil
				}
				opt.SingleRetry = true
				_, _, err := RunFallback(ctx, limits, providers, "", opt)
				if err != nil {
					t.Fatal(err)
				}
				retry, waited := false, false
				for _, n := range trace.Nodes() {
					retry = retry || (n.Kind == "attempt" && n.Attrs["trigger"] == "retry" && n.Attrs["try"] == 2)
					waited = waited || (n.Kind == "wait" && n.Name == "retry")
				}
				if !retry || !waited || len(trace.Attempts()) != 2 {
					t.Fatalf("tree=%+v", trace.Nodes())
				}
			case "untraced notes":
				opt.Kind = "llm"
				opt.Untraced = true
				opt.NoWait = true
				limits.Breaker.Configure(BreakerSettings{Enabled: true})
				limits.Breaker.Disable("off", ClassAuth, "fake", 0)
				rate := config.RateLimit{Requests: 1, Window: time.Minute}
				limits.Rate.TryAcquire("limited", rate)
				providers = []Provider[string, string]{provider("off", config.RateLimit{}, ok("unused")), provider("limited", rate, ok("unused")), provider("model", config.RateLimit{}, func(ctx context.Context) (string, error) {
					_, s := StartSpan(ctx, "llm", "model", nil)
					s.End(nil)
					return "answer", nil
				})}
				_, _, err := RunFallback(ctx, limits, providers, "", opt)
				if err != nil {
					t.Fatal(err)
				}
				attempts := trace.Attempts()
				if len(attempts) != 2 || attempts[0].Status != "skipped" || attempts[1].Status != "limited" {
					t.Fatalf("attempts=%+v", attempts)
				}
				for _, n := range trace.Nodes() {
					if n.Kind == "attempt" && n.Name == "model" {
						t.Fatal("untraced model has an attempt node")
					}
				}
			}
		})
	}
}
