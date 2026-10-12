package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/core"
)

func TestKeyUsageAddsUpByDayToolProviderAndModel(t *testing.T) {
	ctx := context.Background()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	w := st.NewUsageWriter()
	defer w.Close()

	today := time.Now().UnixMilli()
	yesterday := today - dayMs
	tokens := core.Usage{InputTokens: 1000, OutputTokens: 100, CacheReadTokens: 400}
	w.Record(
		UsageSample{TS: today, KeyID: 1, Tool: "fetch", Kind: UsageCall, UsageCount: UsageCount{Calls: 1}},
		UsageSample{TS: today, KeyID: 1, Tool: "fetch", Kind: "fetch", Name: "jina", UsageCount: UsageCount{Calls: 1, Errors: 1}},
		UsageSample{TS: today, KeyID: 1, Tool: "fetch", Kind: "fetch", Name: "exa", UsageCount: UsageCount{Calls: 1}},
		UsageSample{TS: today, KeyID: 1, Tool: "fetch", Kind: UsageModel, Name: "m", UsageCount: UsageCount{Calls: 1}},
		UsageSample{TS: today, KeyID: 1, Tool: "fetch", Kind: UsageModel, Name: "m", UsageCount: UsageCount{Usage: tokens}},
		// A research run searches and fetches on its own.
		UsageSample{TS: yesterday, KeyID: 1, Tool: "research", Kind: UsageCall, UsageCount: UsageCount{Calls: 1, Errors: 1}},
		UsageSample{TS: yesterday, KeyID: 1, Tool: "research", Kind: "search", Name: "brave", UsageCount: UsageCount{Calls: 3}},
		UsageSample{TS: yesterday, KeyID: 1, Tool: "research", Kind: "fetch", Name: "exa", UsageCount: UsageCount{Calls: 2}},
		UsageSample{TS: yesterday, KeyID: 1, Tool: "research", Kind: UsageModel, Name: "big", UsageCount: UsageCount{Calls: 1, Usage: tokens}},
		// Outside the days asked for, and another key's.
		UsageSample{TS: today - 5*dayMs, KeyID: 1, Tool: "search", Kind: UsageCall, UsageCount: UsageCount{Calls: 9}},
		UsageSample{TS: today, KeyID: 2, Tool: "search", Kind: UsageCall, UsageCount: UsageCount{Calls: 7}},
	)
	w.Flush()

	usage, err := st.KeyUsage(ctx, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if usage.Total.Calls != 2 || usage.Total.Errors != 1 || usage.Total.InputTokens != 2000 || usage.Total.CacheReadTokens != 800 {
		t.Errorf("total: %+v", usage.Total)
	}
	if len(usage.Days) != 2 || usage.Days[0].Calls != 1 || usage.Days[0].Errors != 1 || usage.Days[1].Calls != 1 || usage.Days[1].InputTokens != 1000 {
		t.Errorf("days: %+v", usage.Days)
	}
	if usage.Days[1].TS != today/dayMs*dayMs {
		t.Errorf("the last day must be today: %d", usage.Days[1].TS)
	}
	providers := map[[2]string][2]int64{}
	for _, p := range usage.Providers {
		providers[[2]string{p.Kind, p.Provider}] = [2]int64{p.Calls, p.Errors}
	}
	if len(providers) != 3 || providers[[2]string{"fetch", "exa"}] != [2]int64{3, 0} ||
		providers[[2]string{"fetch", "jina"}] != [2]int64{1, 1} || providers[[2]string{"search", "brave"}] != [2]int64{3, 0} {
		t.Errorf("providers: %+v", usage.Providers)
	}
	if len(usage.Models) != 2 || usage.Models[0].Calls != 1 || usage.Models[0].InputTokens != 1000 {
		t.Errorf("models: %+v", usage.Models)
	}
	tools := map[string]UsageCount{}
	for _, tool := range usage.Tools {
		tools[tool.Tool] = tool.UsageCount
	}
	if len(tools) != 2 || tools["fetch"].Calls != 1 || tools["fetch"].OutputTokens != 100 || tools["research"].Errors != 1 {
		t.Errorf("tools: %+v", usage.Tools)
	}

	totals, err := st.KeyUsageTotals(ctx, 30)
	if err != nil {
		t.Fatal(err)
	}
	if totals[1].Calls != 11 || totals[1].InputTokens != 2000 || totals[2].Calls != 7 {
		t.Errorf("totals: %+v", totals)
	}

	if err := st.DeleteAPIKey(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if usage, _ := st.KeyUsage(ctx, 1, 30); usage.Total.Calls != 0 {
		t.Errorf("a deleted key must take its usage with it: %+v", usage.Total)
	}
}

func TestAPIKeyPolicyAndExpiry(t *testing.T) {
	ctx := context.Background()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	plain, plainSecret, err := st.CreateAPIKey(ctx, KeySpec{Name: "plain", Scopes: []string{"search"}})
	if err != nil {
		t.Fatal(err)
	}
	policy := KeyPolicy{ExtractModels: []string{"a", "b"}, ResearchModel: "c", Research: KeyResearch{MaxSteps: 5, QuickOnly: true, Concurrency: 2}}
	_, secret, err := st.CreateAPIKey(ctx, KeySpec{Name: "bound", Scopes: []string{"research"}, ExpiresAt: now() + 60000, Policy: policy})
	if err != nil {
		t.Fatal(err)
	}

	key, ok, err := st.LookupAPIKey(ctx, secret)
	if err != nil || !ok {
		t.Fatalf("lookup: %v %v", ok, err)
	}
	if !slices.Equal(key.Policy.ExtractModels, policy.ExtractModels) || key.Policy.ResearchModel != "c" || key.Policy.Research != policy.Research || key.Expired() {
		t.Errorf("stored key: %+v", key)
	}

	if err := st.UpdateAPIKey(ctx, key.ID, KeySpec{Name: "bound", Scopes: []string{"research"}, ExpiresAt: now() - 1}); err != nil {
		t.Fatal(err)
	}
	key, _, _ = st.LookupAPIKey(ctx, secret)
	if !key.Expired() || key.Policy.ResearchModel != "" || len(key.Policy.ExtractModels) != 0 {
		t.Errorf("updated key: %+v", key)
	}
	if got, _, _ := st.LookupAPIKey(ctx, plainSecret); got.ID != plain.ID || got.Expired() || got.Policy.Research != (KeyResearch{}) {
		t.Errorf("a key without a policy: %+v", got)
	}
}

// A database from before key policies gains their columns, and its keys work
// as they did.
func TestOpenUpgradesKeysFromBeforePolicies(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "seekmux.db"))
	if err != nil {
		t.Fatal(err)
	}
	secret := NewToken(KeyPrefix)
	if _, err := db.Exec(`CREATE TABLE api_keys (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
			scopes TEXT NOT NULL, rate_limit TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
		INSERT INTO api_keys (name, prefix, hash, scopes, created_at) VALUES ('old', 'smx_old', ?, '["search"]', 1)`, HashToken(secret)); err != nil {
		t.Fatal(err)
	}
	db.Close()

	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	key, ok, err := st.LookupAPIKey(context.Background(), secret)
	if err != nil || !ok {
		t.Fatalf("lookup: %v %v", ok, err)
	}
	if key.Name != "old" || key.Expired() || key.ExpiresAt != 0 || len(key.Policy.ExtractModels) != 0 {
		t.Errorf("upgraded key: %+v", key)
	}
}
