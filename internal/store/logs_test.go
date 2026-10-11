package store

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/core"
)

func TestHopsCondenseTheRoute(t *testing.T) {
	straight := `[{"kind":"fetch","provider":"jina","status":"cached"},{"kind":"llm","provider":"m","status":"ok"}]`
	if got := hops(straight); got != nil {
		t.Fatalf("a call that went straight through has no route to show, got %+v", got)
	}
	detour := `[
		{"kind":"fetch","provider":"jina","status":"skipped"},
		{"kind":"fetch","provider":"firecrawl","status":"ok"},
		{"kind":"llm","provider":"a","status":"error"},
		{"kind":"llm","provider":"a","status":"error"},
		{"kind":"llm","provider":"b","status":"ok"}]`
	want := []Hop{
		{"fetch", "jina", "skipped", 1}, {"fetch", "firecrawl", "ok", 1},
		{"llm", "a", "error", 2}, {"llm", "b", "ok", 1},
	}
	if got := hops(detour); !reflect.DeepEqual(got, want) {
		t.Fatalf("hops = %+v", got)
	}

	limited := `[{"kind":"search","provider":"brave","status":"limited"},{"kind":"search","provider":"exa","status":"ok"}]`
	if got := hops(limited); !reflect.DeepEqual(got, []Hop{{"search", "brave", "limited", 1}, {"search", "exa", "ok", 1}}) {
		t.Fatalf("a rate-limited provider changes the route, got %+v", got)
	}
}

func TestLogsAreTalliedAndFilteredByCaller(t *testing.T) {
	ctx := context.Background()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now().UnixMilli()
	w := st.NewLogWriter()
	for _, e := range []LogEntry{
		{Tool: "search", Source: "mcp", APIKeyID: 1, APIKeyName: "old name", Status: StatusOK, DurationMs: 10},
		{Tool: "fetch", Source: "mcp", APIKeyID: 1, APIKeyName: "agent", Status: StatusError, DurationMs: 30, Usage: core.Usage{InputTokens: 5}},
		{Tool: "fetch", Source: "mcp", APIKeyID: 2, APIKeyName: "other", Status: StatusOK, DurationMs: 20},
		{Tool: "search", Source: "webui", Status: StatusOK, DurationMs: 5},
	} {
		e.TS = now
		w.Write(e)
	}
	w.Close()

	stats, err := st.Stats(ctx, time.Hour, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats.Callers) != 3 {
		t.Fatalf("callers = %+v", stats.Callers)
	}
	if top := stats.Callers[0]; top.APIKeyID != 1 || top.APIKeyName != "agent" || top.Calls != 2 || top.Errors != 1 || top.InputTokens != 5 || top.P95Ms != 30 {
		t.Fatalf("top caller = %+v", top)
	}

	entries, err := st.ListLogs(ctx, LogFilter{APIKey: 1})
	if err != nil || len(entries) != 2 {
		t.Fatalf("entries = %+v, err = %v", entries, err)
	}
}
