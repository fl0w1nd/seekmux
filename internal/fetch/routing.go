package fetch

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
)

// routedProviders returns the providers of a rule in its order. They serve
// it with their route's parameters whether or not the route is enabled.
func routedProviders(cfg *config.Config, providers []core.Provider[Input, Page], rule config.Rule, w Workers) []core.Provider[Input, Page] {
	var out []core.Provider[Input, Page]
	for _, id := range rule.Providers {
		if i := slices.IndexFunc(providers, func(p core.Provider[Input, Page]) bool { return p.Name == id }); i >= 0 {
			p := providers[i]
			p.Available = cfg.HasCredentials(id) && reachable(cfg, id, w)
			out = append(out, p)
		}
	}
	return out
}

// unavailable says why none of the providers of a rule can be called.
func unavailable(cfg *config.Config, rule config.Rule, w Workers) error {
	for _, id := range rule.Providers {
		if cfg.HasCredentials(id) && !reachable(cfg, id, w) {
			return errors.New("no worker of the fetcher is online with its browser")
		}
	}
	for _, id := range rule.Providers {
		if _, ok := cfg.FetcherByID(id); ok {
			return errors.New("no API key is configured, and no worker of the fetcher is switched on")
		}
	}
	return errors.New("no API key is configured")
}

// RoutedError is a failed fetch of a page that a routing rule keeps to its
// own providers, where the page was never reached. It says so, because the
// caller would otherwise take the failure of one provider for the state of
// the page.
type RoutedError struct {
	Rule config.Rule
	Err  error
	// cfg names the providers of the rule.
	cfg *config.Config
}

func (e *RoutedError) Error() string {
	names := make([]string, len(e.Rule.Providers))
	for i, id := range e.Rule.Providers {
		info, _ := e.cfg.Info(id)
		names[i] = cmp.Or(info.Name, id)
	}
	return fmt.Sprintf("%s pages are read through %s only, and that failed: %s. No other provider was tried.",
		e.Rule.Name, strings.Join(names, ", "), e.Err)
}

func (e *RoutedError) Unwrap() error { return e.Err }

// The ways a provider's attempt at a page can end, for the statistics kept
// per domain.
const (
	OutcomeOK = "ok"
	// OutcomeBlocked is the site turning the provider away: 401, 403, 429, 451.
	OutcomeBlocked = "blocked"
	// OutcomeMissing is a page the site says it does not have.
	OutcomeMissing = "missing"
	// OutcomeFailed is any other way the provider could not get the page.
	OutcomeFailed  = "failed"
	OutcomeTimeout = "timeout"
)

// Observation is how one provider's attempt at a page ended.
type Observation struct {
	Time time.Time
	// Domain is the registrable domain of the page, e.g. youtube.com for
	// m.youtube.com.
	Domain   string
	Provider string
	Outcome  string
	Duration time.Duration
	// Bytes is the size of the text of a page that was read.
	Bytes int
}

// observed wraps the provider's call so that its outcome is reported.
func (s *Service) observed(target string, p core.Provider[Input, Page]) func(context.Context, Input) (Page, error) {
	if s.Observe == nil {
		return p.Execute
	}
	domain := Domain(target)
	return func(ctx context.Context, in Input) (Page, error) {
		started := time.Now()
		page, err := p.Execute(ctx, in)
		if o := outcome(err); o != "" && domain != "" {
			s.Observe(Observation{Time: started, Domain: domain, Provider: p.Name, Outcome: o, Duration: time.Since(started), Bytes: len(page.Content)})
		}
		return page, err
	}
}

// outcome classifies the end of an attempt, or returns "" when it says
// nothing about the site: the attempt lost a race, the caller left, or the
// provider itself was the problem.
func outcome(err error) string {
	var target *core.TargetError
	var httpErr *core.HTTPError
	switch {
	case err == nil:
		return OutcomeOK
	case errors.Is(err, context.Canceled):
		return ""
	case errors.Is(err, context.DeadlineExceeded):
		return OutcomeTimeout
	case errors.As(err, &target):
		switch target.Status {
		case http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests, http.StatusUnavailableForLegalReasons:
			return OutcomeBlocked
		case http.StatusNotFound, http.StatusGone:
			return OutcomeMissing
		}
		return OutcomeFailed
	case errors.As(err, &httpErr) && httpErr.Kind() == core.ClassTarget:
		return OutcomeFailed
	}
	return ""
}

// Domain returns the registrable domain of a URL, or its host when it has
// none, as an IP address does.
func Domain(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" || net.ParseIP(host) != nil {
		return host
	}
	if domain, err := publicsuffix.EffectiveTLDPlusOne(host); err == nil {
		return domain
	}
	return host
}

func traceRoute(ctx context.Context, rt Runtime, target, engine string, rule config.Rule, routed, cached bool) {
	if core.TraceFrom(ctx) == nil {
		return
	}
	mode := "auto"
	pinned := ""
	var matched map[string]any
	routes := rt.Config.Fetch.Routes
	if routed {
		mode = "rule"
		matched = map[string]any{"name": rule.Name, "builtin": rule.Builtin}
		if u, err := url.Parse(target); err == nil {
			for _, p := range rule.Match {
				domain, prefix, _ := strings.Cut(p, "/")
				host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
				if (host == domain || strings.HasSuffix(host, "."+domain)) && (prefix == "" || strings.HasPrefix(u.Path, "/"+prefix)) {
					matched["pattern"] = p
					break
				}
			}
		}
		ordered := make([]config.Route, 0, len(routes))
		for _, id := range rule.Providers {
			for _, route := range routes {
				if route.Provider == id {
					ordered = append(ordered, route)
					break
				}
			}
		}
		for _, route := range routes {
			if !slices.Contains(rule.Providers, route.Provider) {
				ordered = append(ordered, route)
			}
		}
		routes = ordered
	} else if engine != EngineAuto {
		mode, pinned = "pinned", engine
	}
	candidates := make([]core.Candidate, 0, len(routes))
	eligible := false
	for _, route := range routes {
		reason := ""
		switch {
		case routed && !slices.Contains(rule.Providers, route.Provider):
			reason = "not_in_rule"
		case pinned != "" && pinned != route.Provider:
			reason = "not_pinned"
		case !routed && !route.Enabled:
			reason = "disabled"
		case !rt.Config.HasCredentials(route.Provider):
			reason = "no_credentials"
		case !reachable(rt.Config, route.Provider, rt.Workers):
			reason = "offline"
		}
		if reason == "" {
			eligible = true
		}
		candidates = append(candidates, core.Candidate{Provider: route.Provider, Eligible: reason == "", Reason: reason})
	}
	if cached && !eligible {
		attrs := map[string]any{"mode": mode, "candidates": candidates, "cached": true}
		if pinned != "" {
			attrs["pinned"] = pinned
		}
		if len(matched) > 0 {
			attrs["rule"] = matched
		}
		core.Mark(ctx, "route", "", "cached", attrs)
		return
	}
	core.MarkRoute(ctx, mode, pinned, matched, candidates)
}
