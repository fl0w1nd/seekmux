package store

import (
	"context"
	"testing"
	"time"
)

func TestDomainSamplesAreSummedPerProviderAndOutcome(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	now := time.Now().UnixMilli()

	w := s.NewDomainWriter()
	for _, sample := range []DomainSample{
		{TS: now, Domain: "youtube.com", Provider: "tavily", Outcome: "ok", DurationMs: 1000, Bytes: 20000},
		{TS: now, Domain: "youtube.com", Provider: "tavily", Outcome: "ok", DurationMs: 3000, Bytes: 30000},
		{TS: now, Domain: "youtube.com", Provider: "tavily", Outcome: "failed", DurationMs: 500},
		{TS: now, Domain: "youtube.com", Provider: "jina", Outcome: "blocked", DurationMs: 200},
		{TS: now, Domain: "example.com", Provider: "jina", Outcome: "ok", DurationMs: 100, Bytes: 10},
		{TS: now - 30*dayMs, Domain: "old.example", Provider: "jina", Outcome: "ok"},
		{TS: now - (DomainRetentionDays+5)*dayMs, Domain: "ancient.example", Provider: "jina", Outcome: "ok"},
	} {
		w.Record(sample)
	}
	w.Close()
	w.Record(DomainSample{TS: now, Domain: "late.example", Provider: "jina", Outcome: "ok"})

	week, err := s.DomainStats(ctx, 7, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(week) != 2 || week[0].Domain != "youtube.com" || week[0].Calls != 4 || week[0].Outcomes["ok"] != 2 || week[0].Outcomes["blocked"] != 1 {
		t.Fatalf("week = %+v", week)
	}
	tavily := week[0].Providers[0]
	if tavily.Provider != "tavily" || tavily.Calls != 3 || tavily.Outcomes["failed"] != 1 || tavily.AvgMs != 2000 || tavily.AvgBytes != 25000 {
		t.Errorf("tavily = %+v", tavily)
	}

	if all, _ := s.DomainStats(ctx, DomainRetentionDays, 0); len(all) != 3 {
		t.Errorf("all = %+v", all)
	}
	s.Prune(ctx, 14, 1000)
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM domain_stats WHERE domain = 'ancient.example'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows past the retention: %d, %v", n, err)
	}
	if top, _ := s.DomainStats(ctx, 7, 1); len(top) != 1 {
		t.Errorf("top = %+v", top)
	}
	if err := s.ClearDomainStats(ctx); err != nil {
		t.Fatal(err)
	}
	if none, _ := s.DomainStats(ctx, 7, 0); len(none) != 0 {
		t.Errorf("after clearing: %+v", none)
	}
}
