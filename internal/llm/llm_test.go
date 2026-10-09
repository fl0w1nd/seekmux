package llm

import (
	"testing"

	"charm.land/fantasy"

	"github.com/fl0w1nd/seekmux/internal/core"
)

func TestUsageCountsCachedInput(t *testing.T) {
	got := Usage(fantasy.Usage{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 700, CacheCreationTokens: 200})
	want := core.Usage{InputTokens: 1000, OutputTokens: 20, CacheReadTokens: 700, CacheWriteTokens: 200}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestOutputLimitIsTheTighterOne(t *testing.T) {
	limit := func(model, caller int64) int64 {
		m := &Model{}
		if model > 0 {
			m.MaxOutputTokens = &model
		}
		if got := m.outputLimit(caller); got != nil {
			return *got
		}
		return 0
	}
	for _, c := range []struct{ model, caller, want int64 }{
		{0, 0, 0}, {8000, 0, 8000}, {0, 2000, 2000}, {8000, 2000, 2000}, {1000, 2000, 1000},
	} {
		if got := limit(c.model, c.caller); got != c.want {
			t.Errorf("model %d, caller %d: got %d, want %d", c.model, c.caller, got, c.want)
		}
	}
}
