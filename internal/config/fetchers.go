package config

import (
	"crypto/subtle"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

// Fetcher is a self-hosted fetcher: workers the user runs on devices of
// their own, which the fetch routes and the routing rules see as one
// provider whose id is the fetcher's. A fetch goes to the first of its
// workers that can take it, in their order; the next one gets it only when
// those before it cannot (offline, every slot taken, the worker itself
// failing), not when the page could not be read.
type Fetcher struct {
	ID string `json:"id"`
	// Type names the software the workers run: one of FetcherTypes.
	Type string `json:"type"`
	Name string `json:"name"`
	// RateLimit and Concurrency bound the fetcher as a whole; an empty rate
	// limit or a concurrency of 0 sets no bound.
	RateLimit   string   `json:"rate_limit"`
	Concurrency int      `json:"concurrency"`
	Workers     []Worker `json:"workers"`
}

// Worker is one device of a fetcher.
type Worker struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	// Token is what the worker presents to connect. TokenHint is only set on
	// documents sent to the WebUI; a document from it leaves Token empty to
	// keep the stored one.
	Token     string `json:"token"`
	TokenHint string `json:"token_hint,omitempty"`
	// Profile is the Chrome profile the worker reads with, by its OpenCLI
	// context id; empty leaves the choice to OpenCLI.
	Profile string `json:"profile,omitempty"`
}

// FetcherType describes the software a self-hosted fetcher's workers run.
type FetcherType struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Website          string `json:"website"`
	DefaultRateLimit string `json:"default_rate_limit"`
	// Adapters lists the built-in routing rules whose pages the fetcher
	// reads through a site adapter of its own when a rule sends them to it.
	Adapters []string `json:"adapters,omitempty"`
}

// FetcherOpenCLI reads pages in a logged-in Chrome on each worker, through
// OpenCLI.
const FetcherOpenCLI = "opencli"

// FetcherTypes lists the kinds of self-hosted fetchers.
var FetcherTypes = []FetcherType{
	{
		ID: FetcherOpenCLI, Name: "OpenCLI", Website: "https://github.com/jackwener/opencli",
		DefaultRateLimit: "20/m",
		Adapters:         []string{"twitter", "reddit"},
	},
}

// FetcherTypeByID returns the fetcher type with the given id.
func FetcherTypeByID(id string) (FetcherType, bool) {
	i := slices.IndexFunc(FetcherTypes, func(t FetcherType) bool { return t.ID == id })
	if i < 0 {
		return FetcherType{}, false
	}
	return FetcherTypes[i], true
}

// FetcherByID returns the self-hosted fetcher with the given id.
func (c *Config) FetcherByID(id string) (*Fetcher, bool) {
	for i := range c.Fetchers {
		if c.Fetchers[i].ID == id {
			return &c.Fetchers[i], true
		}
	}
	return nil, false
}

// WorkerByToken returns the fetcher and the worker a token belongs to. The
// comparison takes the same time whichever token matches.
func (c *Config) WorkerByToken(token string) (*Fetcher, *Worker, bool) {
	var fetcher *Fetcher
	var worker *Worker
	for i := range c.Fetchers {
		f := &c.Fetchers[i]
		for j := range f.Workers {
			w := &f.Workers[j]
			if w.Token != "" && subtle.ConstantTimeCompare([]byte(w.Token), []byte(token)) == 1 && worker == nil {
				fetcher, worker = f, w
			}
		}
	}
	return fetcher, worker, worker != nil
}

// ProviderInfo describes a self-hosted fetcher as the provider it is to the
// fetch routes and the routing rules.
func (f *Fetcher) ProviderInfo() ProviderInfo {
	t, _ := FetcherTypeByID(f.Type)
	return ProviderInfo{
		ID: f.ID, Name: f.Name, Website: t.Website,
		Tools:            []string{ToolFetch},
		DefaultBase:      map[string]string{},
		DefaultRateLimit: t.DefaultRateLimit,
		Fetcher:          f.Type,
		Adapters:         t.Adapters,
	}
}

// Info describes a provider of the document: a built-in one or a
// self-hosted fetcher.
func (c *Config) Info(id string) (ProviderInfo, bool) {
	if info, ok := Info(id); ok {
		return info, true
	}
	if f, ok := c.FetcherByID(id); ok {
		return f.ProviderInfo(), true
	}
	return ProviderInfo{}, false
}

func (c *Config) normalizeFetchers() {
	if c.Fetchers == nil {
		c.Fetchers = []Fetcher{}
	}
	for i := range c.Fetchers {
		f := &c.Fetchers[i]
		f.ID, f.Type, f.Name = strings.TrimSpace(f.ID), strings.TrimSpace(f.Type), strings.TrimSpace(f.Name)
		if f.Name == "" {
			f.Name = f.ID
		}
		f.RateLimit = strings.TrimSpace(f.RateLimit)
		f.Concurrency = max(f.Concurrency, 0)
		if f.Workers == nil {
			f.Workers = []Worker{}
		}
		for j := range f.Workers {
			w := &f.Workers[j]
			w.ID, w.Name = strings.TrimSpace(w.ID), strings.TrimSpace(w.Name)
			if w.Name == "" {
				w.Name = w.ID
			}
			w.Token, w.Profile = strings.TrimSpace(w.Token), strings.TrimSpace(w.Profile)
		}
	}
}

func (c *Config) validateFetchers() error {
	fetchers, workers, tokens := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, f := range c.Fetchers {
		if !idPattern.MatchString(f.ID) {
			return fmt.Errorf("fetcher id %q must be lowercase letters, digits, - or _", f.ID)
		}
		// "auto" is fetch_engine's own value for the routes.
		if _, ok := Info(f.ID); ok || fetchers[f.ID] || f.ID == "auto" {
			return fmt.Errorf("fetcher id %q is taken by another provider", f.ID)
		}
		fetchers[f.ID] = true
		if _, ok := FetcherTypeByID(f.Type); !ok {
			return fmt.Errorf("fetcher %q: unknown type %q", f.ID, f.Type)
		}
		if utf8.RuneCountInString(f.Name) > 64 {
			return fmt.Errorf("fetcher %q: the name is longer than 64 characters", f.ID)
		}
		if _, err := ParseRateLimit(f.RateLimit); err != nil {
			return fmt.Errorf("fetcher %q: %w", f.Name, err)
		}
		for _, w := range f.Workers {
			if !idPattern.MatchString(w.ID) {
				return fmt.Errorf("worker id %q must be lowercase letters, digits, - or _", w.ID)
			}
			if workers[w.ID] {
				return fmt.Errorf("worker id %q is used twice", w.ID)
			}
			workers[w.ID] = true
			if utf8.RuneCountInString(w.Name) > 64 {
				return fmt.Errorf("worker %q of %q: the name is longer than 64 characters", w.Name, f.Name)
			}
			if w.Token == "" {
				return fmt.Errorf("worker %q of %q has no token", w.Name, f.Name)
			}
			if tokens[w.Token] {
				return fmt.Errorf("worker %q of %q: another worker has the same token", w.Name, f.Name)
			}
			tokens[w.Token] = true
		}
	}
	return nil
}
