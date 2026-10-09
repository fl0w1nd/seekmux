package store

import (
	"reflect"
	"testing"
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
