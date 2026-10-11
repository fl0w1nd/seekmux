package fetch

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
)

// routedProviders returns the providers of a rule in its order. They serve
// it with their route's parameters whether or not the route is enabled.
func routedProviders(cfg *config.Config, providers []core.Provider[Input, Page], rule config.Rule) []core.Provider[Input, Page] {
	var out []core.Provider[Input, Page]
	for _, id := range rule.Providers {
		if i := slices.IndexFunc(providers, func(p core.Provider[Input, Page]) bool { return p.Name == id }); i >= 0 {
			p := providers[i]
			p.Available = cfg.HasCredentials(id)
			out = append(out, p)
		}
	}
	return out
}

// RoutedError is a failed fetch of a page that a routing rule keeps to its
// own providers, where the page was never reached. It says so, because the
// caller would otherwise take the failure of one provider for the state of
// the page.
type RoutedError struct {
	Rule config.Rule
	Err  error
}

func (e *RoutedError) Error() string {
	names := make([]string, len(e.Rule.Providers))
	for i, id := range e.Rule.Providers {
		info, _ := config.Info(id)
		names[i] = info.Name
	}
	return fmt.Sprintf("%s pages are read through %s only, and that failed: %s. No other provider was tried.",
		e.Rule.Name, strings.Join(names, ", "), e.Err)
}

func (e *RoutedError) Unwrap() error { return e.Err }

// pageNote returns what a caller must be told about a page of a built-in
// rule that came back without the content the rule exists for.
func pageNote(rule config.Rule, page Page) string {
	if rule.Builtin && rule.ID == "youtube" {
		return youtubeNote(page)
	}
	return ""
}

// Tavily renders a video as its title, description and chapters followed by
// the transcript under this heading, which it leaves out when it got none.
var transcriptHeading = regexp.MustCompile(`(?m)^#{1,6} Transcript\s*$`)

func youtubeNote(page Page) string {
	info, _ := config.Info(page.Engine)
	switch {
	case page.Engine != "tavily":
		return info.Name + " does not return the transcript of a video: this is the video's page without what is said in it."
	case !transcriptHeading.MatchString(page.Content):
		return "Tavily read this video but returned no transcript, so the video probably has no captions: this is its title and description only."
	}
	return ""
}

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
