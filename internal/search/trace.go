package search

import (
	"context"
	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
)

func traceRoute(ctx context.Context, cfg *config.Config, routes []config.Route, engine string) {
	if core.TraceFrom(ctx) == nil {
		return
	}
	if engine == "" {
		engine = EngineAuto
	}
	if core.CurrentSpan(ctx) != nil {
		// dev_search has no engine argument; the playground pins it in overrides.
		nodes := core.TraceFrom(ctx).Nodes()
		if len(nodes) > 0 {
			if overrides, ok := nodes[0].Attrs["overrides"].(map[string]any); ok {
				if pin, ok := overrides["pin"].(string); ok && pin != "" {
					engine = pin
				}
			}
		}
	}
	candidates := make([]core.Candidate, 0, len(routes))
	for _, route := range routes {
		reason := ""
		switch {
		case engine != EngineAuto && engine != route.Provider:
			reason = "not_pinned"
		case !route.Enabled:
			reason = "disabled"
		case !cfg.HasCredentials(route.Provider):
			reason = "no_credentials"
		}
		candidates = append(candidates, core.Candidate{Provider: route.Provider, Eligible: reason == "", Reason: reason})
	}
	mode, pinned := "auto", ""
	if engine != EngineAuto {
		mode, pinned = "pinned", engine
	}
	core.MarkRoute(ctx, mode, pinned, nil, candidates)
}
