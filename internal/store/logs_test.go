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

func TestLogsKeepTheClientAndCanBeNarrowedInTime(t *testing.T) {
	ctx := context.Background()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now().UnixMilli()
	w := st.NewLogWriter()
	for _, e := range []LogEntry{
		{TS: now - 20*60_000, Tool: "search", Source: "mcp", APIKeyID: 1, ClientIP: "203.0.113.7", UserAgent: "claude-code/2.1", Status: StatusOK},
		{TS: now - 10*60_000, Tool: "fetch", Source: "mcp", APIKeyID: 1, ClientIP: "198.51.100.2", UserAgent: "codex/0.4", Status: StatusOK},
		{TS: now, Tool: "research", Source: "mcp", APIKeyID: 1, ClientIP: "203.0.113.7", TaskID: "rs_x", Status: StatusOK},
	} {
		w.Write(e)
	}
	w.Close()

	byAgent, err := st.ListLogs(ctx, LogFilter{Query: "codex"})
	if err != nil || len(byAgent) != 1 || byAgent[0].ClientIP != "198.51.100.2" || byAgent[0].UserAgent != "codex/0.4" {
		t.Fatalf("a search matches the user agent, got %+v, err %v", byAgent, err)
	}
	byIP, _ := st.ListLogs(ctx, LogFilter{Query: "203.0.113.7"})
	if len(byIP) != 2 {
		t.Fatalf("a search matches the client address, got %+v", byIP)
	}
	window, _ := st.ListLogs(ctx, LogFilter{Since: now - 15*60_000, Until: now})
	if len(window) != 1 || window[0].Tool != "fetch" {
		t.Fatalf("since is inclusive and until exclusive, got %+v", window)
	}
	research, ok, err := st.GetLog(ctx, byIP[0].ID)
	if err != nil || !ok || research.TaskID != "rs_x" {
		t.Fatalf("the research entry names its task, got %+v, err %v", research, err)
	}

	stats, err := st.Stats(ctx, time.Hour, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats.Callers) != 1 || stats.Callers[0].IPs != 2 {
		t.Fatalf("callers = %+v", stats.Callers)
	}
	tools := map[string]int{}
	for _, b := range stats.Buckets {
		for tool, n := range b.Tools {
			tools[tool] += n
		}
	}
	if !reflect.DeepEqual(tools, map[string]int{"search": 1, "fetch": 1, "research": 1}) {
		t.Fatalf("buckets count calls per tool, got %v", tools)
	}
}

func TestStatsGroupTheFailedAttempts(t *testing.T) {
	ctx := context.Background()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now().UnixMilli()
	w := st.NewLogWriter()
	for i, attempts := range []string{
		`[{"kind":"search","provider":"brave","status":"error","http_status":429,"error":"first"},{"kind":"search","provider":"exa","status":"ok"}]`,
		`[{"kind":"search","provider":"brave","status":"error","http_status":429,"error":"latest"}]`,
		`[{"kind":"search","provider":"brave","status":"error","http_status":500,"error":"boom"},{"kind":"search","provider":"exa","status":"skipped"}]`,
	} {
		w.Write(LogEntry{TS: now + int64(i), Tool: "search", Source: "mcp", Status: StatusOK, Attempts: []byte(attempts)})
	}
	w.Close()

	stats, err := st.Stats(ctx, time.Hour, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	want := []ErrorStats{
		{Kind: "search", Provider: "brave", HTTPStatus: 429, Count: 2, Sample: "latest", LastTS: now + 1},
		{Kind: "search", Provider: "brave", HTTPStatus: 500, Count: 1, Sample: "boom", LastTS: now + 2},
	}
	if !reflect.DeepEqual(stats.Errors, want) {
		t.Fatalf("errors = %+v", stats.Errors)
	}
}

func TestStatsOrderTiesByName(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now().UnixMilli()
	w := st.NewLogWriter()
	w.Write(LogEntry{TS: now, Tool: "search", Source: "mcp", Status: StatusError, Attempts: []byte(
		`[{"kind":"search","provider":"tavily","status":"error","http_status":500},{"kind":"search","provider":"exa","status":"error","http_status":429},{"kind":"search","provider":"brave","status":"error","http_status":500}]`)})
	w.Close()

	// The groups are built in a map, so a tie must not decide the order.
	for range 20 {
		stats, err := st.Stats(context.Background(), time.Hour, 5*time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		var errs, provs []string
		for _, e := range stats.Errors {
			errs = append(errs, e.Provider)
		}
		for _, p := range stats.Providers {
			provs = append(provs, p.Provider)
		}
		want := []string{"brave", "exa", "tavily"}
		if !reflect.DeepEqual(errs, want) || !reflect.DeepEqual(provs, want) {
			t.Fatalf("errors %v, providers %v; want %v", errs, provs, want)
		}
	}
}
