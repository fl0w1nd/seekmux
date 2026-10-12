package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/store"
)

func TestOverrideReplacesModelsForOneCall(t *testing.T) {
	cfg := config.Default()
	cfg.LLM.Providers = []config.LLMProvider{{
		ID: "p", Name: "P", Type: config.LLMOpenAICompatible, BaseURL: "https://llm.example.com/v1",
		Models: []config.Model{{ID: "a", Name: "a"}, {ID: "b", Name: "b"}, {ID: "c", Name: "c"}},
	}}
	cfg.Fetch.Extract.Models = []string{"a", "b"}
	cfg.Research.Model = "a"
	live := &Snapshot{Version: 3, Config: cfg}

	if s, err := live.with(config.ToolFetch, Override{}); err != nil || s != live {
		t.Fatalf("an empty override must keep the snapshot: %v", err)
	}

	s, err := live.with(config.ToolFetch, Override{ExtractModel: "c", ResearchModel: "b"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(s.Config.Fetch.Extract.Models, []string{"c"}) || s.Config.Research.Model != "b" {
		t.Errorf("overridden: extract %v, research %q", s.Config.Fetch.Extract.Models, s.Config.Research.Model)
	}
	if !slices.Equal(cfg.Fetch.Extract.Models, []string{"a", "b"}) || cfg.Research.Model != "a" {
		t.Errorf("the live configuration changed: extract %v, research %q", cfg.Fetch.Extract.Models, cfg.Research.Model)
	}

	if _, err := live.with(config.ToolResearch, Override{ResearchModel: "missing"}); err == nil {
		t.Error("an unknown model must be rejected")
	}
}

func TestOverrideReplacesTheResearchBudgetForOneRun(t *testing.T) {
	cfg := config.Default()
	live := &Snapshot{Version: 1, Config: cfg}

	s, err := live.with(config.ToolResearch, Override{Research: ResearchOverride{MaxSteps: 3, MaxTokens: 9000, Reading: config.ReadingExtract}})
	if err != nil {
		t.Fatal(err)
	}
	got, want := s.Config.Research, cfg.Research
	if got.MaxSteps != 3 || got.MaxTokens != 9000 || got.Reading != config.ReadingExtract {
		t.Errorf("overridden budget: %+v", got)
	}
	if got.MaxDurationSeconds != want.MaxDurationSeconds || got.MaxContextTokens != want.MaxContextTokens {
		t.Errorf("a limit left at zero must keep the configured one: %+v", got)
	}
	if want.MaxSteps == 3 || want.Reading != config.ReadingRaw {
		t.Errorf("the live configuration changed: %+v", want)
	}

	for _, bad := range []ResearchOverride{{MaxSteps: -1}, {MaxSteps: maxResearchSteps + 1}, {MaxDurationSeconds: maxResearchDuration + 1}, {MaxTokens: -5}, {Reading: "skim"}} {
		if _, err := live.with(config.ToolResearch, Override{Research: bad}); err == nil {
			t.Errorf("%+v must be rejected", bad)
		}
	}
}

func TestOverrideTunesAndPinsARouteForOneCall(t *testing.T) {
	cfg := config.Default()
	cfg.Normalize()
	for i := range cfg.Fetch.Routes {
		cfg.Fetch.Routes[i].Enabled = true
	}
	live := &Snapshot{Version: 1, Config: cfg}
	route := func(c *config.Config, provider string) config.Route {
		for _, r := range c.Fetch.Routes {
			if r.Provider == provider {
				return r
			}
		}
		t.Fatalf("no fetch route %q", provider)
		return config.Route{}
	}

	s, err := live.with(config.ToolFetch, Override{
		Route: &RouteOverride{Provider: "jina", Options: map[string]any{"engine": "browser", "unknown": 1}, ExtraBody: map[string]any{"X-Timeout": 30}},
		Pin:   "jina",
	})
	if err != nil {
		t.Fatal(err)
	}
	tuned := route(s.Config, "jina")
	if tuned.Options["engine"] != "browser" || len(tuned.Options) != 1 || tuned.ExtraBody["X-Timeout"] == nil {
		t.Errorf("tuned route: %+v", tuned)
	}
	for _, r := range s.Config.Fetch.Routes {
		if r.Enabled != (r.Provider == "jina") {
			t.Errorf("only the pinned provider stays enabled, got %+v", r)
		}
	}
	if kept := route(cfg, "jina"); kept.Options != nil || kept.ExtraBody != nil || !route(cfg, "exa").Enabled {
		t.Errorf("the live configuration changed: %+v", cfg.Fetch.Routes)
	}

	for _, bad := range []Override{
		{Route: &RouteOverride{Provider: "jina", Options: map[string]any{"engine": "warp"}}},
		{Route: &RouteOverride{Provider: "brave"}},
		{Pin: "brave"},
	} {
		if _, err := live.with(config.ToolFetch, bad); err == nil {
			t.Errorf("%+v must be rejected", bad)
		}
	}
}

func TestQuickResearchRunsOnAThirdOfTheBudget(t *testing.T) {
	cfg := config.Default()
	live := &Snapshot{Config: cfg}

	s, err := live.with(config.ToolResearch, Override{Research: ResearchOverride{Quick: true}})
	if err != nil {
		t.Fatal(err)
	}
	got, want := s.Config.Research, cfg.Research
	if got.MaxSteps != want.MaxSteps/3 || got.MaxDurationSeconds != want.MaxDurationSeconds/3 || got.MaxTokens != want.MaxTokens/3 {
		t.Errorf("quick budget = %d steps, %d s, %d tokens of %d, %d, %d", got.MaxSteps, got.MaxDurationSeconds, got.MaxTokens, want.MaxSteps, want.MaxDurationSeconds, want.MaxTokens)
	}
	if got.MaxContextTokens != want.MaxContextTokens {
		t.Errorf("quick changed the context limit to %d", got.MaxContextTokens)
	}

	// A budget below the floors is left as it is rather than raised.
	s, err = live.with(config.ToolResearch, Override{Research: ResearchOverride{Quick: true, MaxSteps: 2, MaxDurationSeconds: 30}})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Config.Research; got.MaxSteps != 2 || got.MaxDurationSeconds != 30 {
		t.Errorf("quick raised a small budget to %d steps, %d s", got.MaxSteps, got.MaxDurationSeconds)
	}
}

func TestKeyPolicyReplacesModelsAndCapsResearch(t *testing.T) {
	cfg := config.Default()
	cfg.LLM.Providers = []config.LLMProvider{{
		ID: "p", Name: "P", Type: config.LLMOpenAICompatible, BaseURL: "https://llm.example.com/v1",
		Models: []config.Model{{ID: "a", Name: "a"}, {ID: "b", Name: "b"}, {ID: "c", Name: "c"}},
	}}
	cfg.Fetch.Extract.Models = []string{"a", "b"}
	cfg.Research.Model = "a"
	cfg.Research.MaxSteps, cfg.Research.MaxDurationSeconds, cfg.Research.MaxTokens = 30, 600, 900000
	live := &Snapshot{Version: 3, Config: cfg}

	if s := live.under(store.KeyPolicy{}); s != live {
		t.Fatal("an empty policy must keep the snapshot")
	}
	// A policy naming only models that are gone changes nothing either.
	if s := live.under(store.KeyPolicy{ExtractModels: []string{"gone"}, ResearchModel: "gone"}); s != live {
		t.Fatal("a policy whose models no longer exist must keep the snapshot")
	}

	s := live.under(store.KeyPolicy{
		ExtractModels: []string{"c", "gone", "a"}, ResearchModel: "b",
		Research: store.KeyResearch{MaxSteps: 10, MaxDurationSeconds: 9000, MaxTokens: 100000},
	})
	if !slices.Equal(s.Config.Fetch.Extract.Models, []string{"c", "a"}) || s.Config.Research.Model != "b" {
		t.Errorf("models: extract %v, research %q", s.Config.Fetch.Extract.Models, s.Config.Research.Model)
	}
	if r := s.Config.Research; r.MaxSteps != 10 || r.MaxDurationSeconds != 600 || r.MaxTokens != 100000 {
		t.Errorf("a ceiling must lower a budget and never raise it: %+v", r)
	}
	if !slices.Equal(cfg.Fetch.Extract.Models, []string{"a", "b"}) || cfg.Research.MaxSteps != 30 {
		t.Error("the live configuration changed")
	}
}

func TestQuickOnlyKeyRunsEveryResearchQuick(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, err := New(context.Background(), st)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	full := a.Snapshot().Config.Research

	caller := Caller{KeyID: 1, Policy: store.KeyPolicy{Research: store.KeyResearch{QuickOnly: true, MaxSteps: 5}}}
	s, err := a.view(caller, config.ToolResearch, Override{})
	if err != nil {
		t.Fatal(err)
	}
	if r := s.Config.Research; r.MaxSteps != min(5, max(full.MaxSteps/3, quickResearchSteps)) || r.MaxTokens >= full.MaxTokens {
		t.Errorf("quick-only research budget: %+v of %+v", r, full)
	}
	if s, _ := a.view(caller, config.ToolFetch, Override{}); s.Config.Research.MaxTokens != full.MaxTokens {
		t.Error("quick-only must only touch research calls")
	}
}

func TestKeyResearchConcurrency(t *testing.T) {
	a := &App{researching: map[int64]int{}}
	caller := Caller{KeyID: 7, Policy: store.KeyPolicy{Research: store.KeyResearch{Concurrency: 2}}}
	first, err := a.admitResearch(caller)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.admitResearch(caller); err != nil {
		t.Fatal(err)
	}
	if _, err := a.admitResearch(caller); err == nil {
		t.Fatal("a third run must be turned away")
	}
	if _, err := a.admitResearch(Caller{KeyID: 8}); err != nil {
		t.Fatalf("a key without a bound is never turned away: %v", err)
	}
	first()
	if _, err := a.admitResearch(caller); err != nil {
		t.Fatalf("a finished run must free its place: %v", err)
	}
}

func TestUsageOfCountsWhatReachedUpstream(t *testing.T) {
	trace := core.NewTrace()
	trace.Record(config.ToolFetch, "jina", "https://example.com", time.Now(), errors.New("boom"))
	trace.Record(config.ToolFetch, "exa", "https://example.com", time.Now(), nil)
	trace.Note(config.ToolFetch, "exa", "https://example.com/b", core.AttemptCached)
	trace.Skip(config.ToolFetch, "tavily", "https://example.com", "breaker open")
	trace.Record("llm", "m", "", time.Now(), nil)
	trace.AddUsage("m", core.Usage{InputTokens: 100, OutputTokens: 20})

	got := map[[2]string]store.UsageCount{}
	for _, s := range usageOf(store.LogEntry{TS: 1, APIKeyID: 4, Tool: config.ToolFetch, Status: store.StatusOK}, trace) {
		if s.KeyID != 4 || s.Tool != config.ToolFetch {
			t.Fatalf("sample of the wrong call: %+v", s)
		}
		key := [2]string{s.Kind, s.Name}
		got[key] = store.UsageCount{Calls: got[key].Calls + s.Calls, Errors: got[key].Errors + s.Errors, Usage: got[key].Usage.Add(s.Usage)}
	}
	want := map[[2]string]store.UsageCount{
		{store.UsageCall, ""}:      {Calls: 1},
		{config.ToolFetch, "jina"}: {Calls: 1, Errors: 1},
		{config.ToolFetch, "exa"}:  {Calls: 1},
		{store.UsageModel, "m"}:    {Calls: 1, Usage: core.Usage{InputTokens: 100, OutputTokens: 20}},
	}
	if !maps.Equal(got, want) {
		t.Errorf("usage:\n got %+v\nwant %+v", got, want)
	}
}

func TestConfigurationIsEncryptedAtRest(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// A database from before encryption holds the document in plain text.
	cfg := config.Default()
	cfg.Providers["brave"] = &config.Provider{Secret: config.Secret{APIKey: "plain-secret"}}
	plain, _ := json.Marshal(cfg)
	if err := st.Set(ctx, configKey, plain); err != nil {
		t.Fatal(err)
	}
	stored := func() []byte {
		raw, err := st.Get(ctx, configKey)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}

	a, err := New(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	if got := a.Snapshot().Config.Providers["brave"].APIKey; got != "plain-secret" {
		t.Fatalf("key after the upgrade: %q", got)
	}
	if raw := stored(); !store.Sealed(raw) || bytes.Contains(raw, []byte("plain-secret")) {
		t.Error("opening an old database must encrypt its configuration")
	}

	next := a.Snapshot().Config.Clone()
	next.Providers["brave"].APIKey = "second-secret"
	if err := a.SaveConfig(ctx, next); err != nil {
		t.Fatal(err)
	}
	if raw := stored(); !store.Sealed(raw) || bytes.Contains(raw, []byte("second-secret")) {
		t.Error("a saved configuration must be encrypted")
	}
	a.Close()
	st.Close()

	// The key file reopens it; another key must not.
	if st, err = store.Open(dir); err != nil {
		t.Fatal(err)
	}
	if a, err = New(ctx, st); err != nil {
		t.Fatal(err)
	}
	if got := a.Snapshot().Config.Providers["brave"].APIKey; got != "second-secret" {
		t.Errorf("key after a restart: %q", got)
	}
	a.Close()
	st.Close()

	t.Setenv(store.EncryptionKeyEnv, "some other key")
	if st, err = store.Open(dir); err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := New(ctx, st); err == nil {
		t.Error("the wrong key must not open the configuration")
	}
}
