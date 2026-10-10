package app

import (
	"slices"
	"testing"

	"github.com/fl0w1nd/seekmux/internal/config"
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
