package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/core"
)

func TestRegistry(t *testing.T) {
	for _, name := range []string{"subscribe", "overflow", "retention", "cancel", "activity"} {
		t.Run(name, func(t *testing.T) {
			registry := NewRegistry()
			defer registry.Close()
			trace := core.NewTrace()
			ctx, cancel := context.WithCancelCause(core.WithTrace(context.Background(), trace))
			defer cancel(nil)
			if name == "retention" {
				registry.retention = 20 * time.Millisecond
			}
			buffer := 16
			if name == "overflow" {
				buffer = 1
			}
			events, stop := registry.Subscribe(buffer)
			defer stop()
			if name != "overflow" {
				if event := <-events; event.Type != "snapshot" || len(event.Snapshot.Calls) != 0 {
					t.Fatal("initial snapshot")
				}
			}
			registry.Start(LiveCall{CallID: trace.CallID, Tool: "fetch", StartedAt: trace.Start.UnixMilli(), TaskID: "rs_fake"}, trace, cancel)
			if name == "overflow" {
				if e := <-events; e.Type != "snapshot" || len(e.Snapshot.Calls) != 1 {
					t.Fatalf("overflow=%+v", e)
				}
			} else {
				if e := <-events; e.Type != "call" || e.Call.CallID != trace.CallID {
					t.Fatalf("start=%+v", e)
				}
			}
			if registry.TaskCall("rs_fake") != trace.CallID {
				t.Fatal("missing task call")
			}
			switch name {
			case "activity":
				parent, _ := core.StartSpan(ctx, "step", "4", nil)
				_, child := core.StartSpan(parent, "attempt", "fake", nil)
				select {
				case e := <-events:
					if e.Type != "call" || e.Call.Step != 4 || len(e.Call.Active) != 1 || e.Call.Active[0].ID != child.ID() {
						t.Fatalf("activity=%+v", e)
					}
				case <-time.After(time.Second):
					t.Fatal("no activity event")
				}
			case "cancel":
				if !registry.Cancel(trace.CallID) || !errors.Is(context.Cause(ctx), ErrCallStopped) {
					t.Fatal("cancel did not reach call")
				}
				if registry.Cancel("c_missing") {
					t.Fatal("unknown cancel succeeded")
				}
			}
			trace.Seal("ok", "")
			registry.Finish(trace.CallID, core.CallDone{CallID: trace.CallID, Status: "ok", DurationMs: 1})
			if len(registry.Snapshot().Calls) != 0 || registry.Cancel(trace.CallID) {
				t.Fatal("finished call is running")
			}
			_, retained, found := registry.Get(trace.CallID)
			if !found {
				t.Fatal("finished call not retained")
			}
			live, unsub := retained.Subscribe(2)
			defer unsub()
			if e := <-live; e.Type != "snapshot" || e.Snapshot.Done == nil || e.Snapshot.Done.Status != "ok" {
				t.Fatal("late subscriber lost completion")
			}
			if name == "retention" {
				deadline := time.After(time.Second)
				for {
					_, _, ok := registry.Get(trace.CallID)
					if !ok {
						break
					}
					select {
					case <-deadline:
						t.Fatal("retained call never dropped")
					case <-time.After(5 * time.Millisecond):
					}
				}
			}
		})
	}
}
