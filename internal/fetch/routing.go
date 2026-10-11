package fetch

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

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
