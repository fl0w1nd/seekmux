package core

import "context"

type Candidate struct {
	Provider string `json:"provider"`
	Eligible bool   `json:"eligible"`
	Reason   string `json:"reason"`
}

func MarkRoute(ctx context.Context, mode, engine string, rule map[string]any, candidates []Candidate) {
	attrs := map[string]any{"mode": mode, "candidates": candidates}
	if engine != "" {
		attrs["engine"] = engine
	}
	if rule != nil {
		attrs["rule"] = rule
	}
	status := "error"
	for _, c := range candidates {
		if c.Eligible {
			status = "ok"
			break
		}
	}
	Mark(ctx, "route", "", status, attrs)
}
