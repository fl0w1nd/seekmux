package config

import (
	"fmt"
	"slices"
	"strings"
)

// Social configures the tools that search social platforms. Each platform
// is a source of its own, served by the workers of a self-hosted fetcher
// signed in to it.
type Social struct {
	TimeoutSeconds float64        `json:"timeout_seconds"`
	Sources        []SocialSource `json:"sources"`
}

// SocialSource binds a platform to the workers that search it.
type SocialSource struct {
	// Platform is one of SocialPlatforms, by id.
	Platform string `json:"platform"`
	Enabled  bool   `json:"enabled"`
	// Fetcher is the self-hosted fetcher whose workers search the platform;
	// its rate limit and concurrency bound the searches too.
	Fetcher string `json:"fetcher"`
	// Workers are the fetcher's workers that search the platform, by id.
	// They are tried in the fetcher's order; the next one only when the one
	// before cannot take the search (offline, busy, without its browser, too
	// old), not when the platform refused it.
	Workers []string `json:"workers"`
}

// SocialPlatform describes a platform a social source can search.
type SocialPlatform struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Tool is the MCP tool that searches the platform.
	Tool string `json:"tool"`
	// FetcherType is the kind of self-hosted fetcher that can serve it.
	FetcherType string `json:"fetcher_type"`
	// Feature is what a worker announces when it can search the platform;
	// MinWorker is the first worker version that does.
	Feature   string `json:"feature"`
	MinWorker string `json:"min_worker"`
}

// PlatformX is X, formerly Twitter.
const PlatformX = "x"

// SocialPlatforms lists the platforms the social tools search.
var SocialPlatforms = []SocialPlatform{
	{ID: PlatformX, Name: "X（Twitter）", Tool: ToolXSearch, FetcherType: FetcherOpenCLI, Feature: "x_search", MinWorker: "0.0.4"},
}

// SocialPlatformByID returns the platform with the given id.
func SocialPlatformByID(id string) (SocialPlatform, bool) {
	i := slices.IndexFunc(SocialPlatforms, func(p SocialPlatform) bool { return p.ID == id })
	if i < 0 {
		return SocialPlatform{}, false
	}
	return SocialPlatforms[i], true
}

// SocialSource returns the source of a platform.
func (c *Config) SocialSource(platform string) (*SocialSource, bool) {
	for i := range c.Social.Sources {
		if c.Social.Sources[i].Platform == platform {
			return &c.Social.Sources[i], true
		}
	}
	return nil, false
}

// SourceWorkers returns the fetcher of a platform's source and, in the
// fetcher's order, the workers of it the source names that are switched
// on. It is false when the source is missing, switched off or has no
// fetcher.
func (c *Config) SourceWorkers(platform string) (*Fetcher, []Worker, bool) {
	src, ok := c.SocialSource(platform)
	if !ok || !src.Enabled || src.Fetcher == "" {
		return nil, nil, false
	}
	f, ok := c.FetcherByID(src.Fetcher)
	if !ok {
		return nil, nil, false
	}
	var out []Worker
	for _, w := range f.Workers {
		if w.Enabled && slices.Contains(src.Workers, w.ID) {
			out = append(out, w)
		}
	}
	return f, out, true
}

// SocialAvailable reports whether the tool of a platform is offered: its
// source is switched on and names a worker that is switched on. Whether the
// worker is online is only learned when the tool is called.
func (c *Config) SocialAvailable(platform string) bool {
	_, workers, ok := c.SourceWorkers(platform)
	return ok && len(workers) > 0
}

// normalizeSocial runs after normalizeFetchers: a source keeps only workers
// its fetcher still has, and loses a fetcher that is gone or cannot serve
// the platform, so that removing a fetcher or a worker does not make the
// document invalid.
func (c *Config) normalizeSocial() {
	if c.Social.TimeoutSeconds <= 0 {
		c.Social.TimeoutSeconds = 45
	}
	if c.Social.Sources == nil {
		c.Social.Sources = []SocialSource{}
	}
	for i := range c.Social.Sources {
		s := &c.Social.Sources[i]
		s.Platform, s.Fetcher = strings.TrimSpace(s.Platform), strings.TrimSpace(s.Fetcher)
		platform, known := SocialPlatformByID(s.Platform)
		f, ok := c.FetcherByID(s.Fetcher)
		if !known || !ok || f.Type != platform.FetcherType {
			s.Fetcher = ""
		}
		var workers []string
		for _, id := range s.Workers {
			id = strings.TrimSpace(id)
			if ok && s.Fetcher != "" && slices.ContainsFunc(f.Workers, func(w Worker) bool { return w.ID == id }) && !slices.Contains(workers, id) {
				workers = append(workers, id)
			}
		}
		if workers == nil {
			workers = []string{}
		}
		s.Workers = workers
	}
}

func (c *Config) validateSocial() error {
	seen := map[string]bool{}
	for _, s := range c.Social.Sources {
		if _, ok := SocialPlatformByID(s.Platform); !ok {
			return fmt.Errorf("social: unknown platform %q", s.Platform)
		}
		if seen[s.Platform] {
			return fmt.Errorf("social: platform %q is added twice", s.Platform)
		}
		seen[s.Platform] = true
	}
	return nil
}
