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

	if s, err := live.with(Override{}); err != nil || s != live {
		t.Fatalf("an empty override must keep the snapshot: %v", err)
	}

	s, err := live.with(Override{ExtractModel: "c", ResearchModel: "b"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(s.Config.Fetch.Extract.Models, []string{"c"}) || s.Config.Research.Model != "b" {
		t.Errorf("overridden: extract %v, research %q", s.Config.Fetch.Extract.Models, s.Config.Research.Model)
	}
	if !slices.Equal(cfg.Fetch.Extract.Models, []string{"a", "b"}) || cfg.Research.Model != "a" {
		t.Errorf("the live configuration changed: extract %v, research %q", cfg.Fetch.Extract.Models, cfg.Research.Model)
	}

	if _, err := live.with(Override{ResearchModel: "missing"}); err == nil {
		t.Error("an unknown model must be rejected")
	}
}
