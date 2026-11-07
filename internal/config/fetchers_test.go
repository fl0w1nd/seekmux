package config

import (
	"strings"
	"testing"
)

func withFetcher() *Config {
	c := Default()
	c.Fetchers = []Fetcher{{
		ID: "home", Type: FetcherOpenCLI, Name: "Home", RateLimit: "10/m", Concurrency: 2,
		Workers: []Worker{
			{ID: "w1", Name: "Laptop", Enabled: true, Token: "token-one", Profile: "p1"},
			{ID: "w2", Name: "Desktop", Token: "token-two"},
		},
	}}
	c.Routing.Builtin = map[string]BuiltinRule{"twitter": {Enabled: true, Providers: []string{"home"}}}
	c.Normalize()
	return c
}

// A self-hosted fetcher is a fetch provider like the built-in ones: it gets a
// route of its own, off until someone turns it on, and a rule may name it.
func TestAFetcherIsAFetchProvider(t *testing.T) {
	c := withFetcher()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	last := c.Fetch.Routes[len(c.Fetch.Routes)-1]
	if last.Provider != "home" || last.Enabled {
		t.Fatalf("last fetch route = %+v", last)
	}
	for _, r := range c.Search.Routes {
		if r.Provider == "home" {
			t.Fatal("a fetcher got a search route")
		}
	}
	if rule, ok := c.RuleFor("https://x.com/a/status/1"); !ok || rule.Providers[0] != "home" {
		t.Fatalf("rule = %+v, %v", rule, ok)
	}
	info, ok := c.Info("home")
	if !ok || info.Name != "Home" || info.Fetcher != FetcherOpenCLI || !info.Supports(ToolFetch) || len(info.Adapters) == 0 {
		t.Fatalf("info = %+v", info)
	}
	if limit, concurrency := c.Limits("home"); limit.Requests != 10 || concurrency != 2 || c.RateLimitText("home") != "10/m" {
		t.Fatalf("limits = %+v, %d", limit, concurrency)
	}
	if !c.HasCredentials("home") {
		t.Fatal("a fetcher with a worker switched on has no credentials")
	}
	c.Fetchers[0].Workers[0].Enabled = false
	if c.HasCredentials("home") {
		t.Fatal("a fetcher without a worker switched on has credentials")
	}
}

// Removing a fetcher takes its routes and its place in the rules with it.
func TestARemovedFetcherLeavesNoRoute(t *testing.T) {
	c := withFetcher()
	c.Fetchers = nil
	c.Normalize()
	for _, r := range c.Fetch.Routes {
		if r.Provider == "home" {
			t.Fatal("the route of a removed fetcher stayed")
		}
	}
	if o := c.Routing.Builtin["twitter"]; len(o.Providers) != 0 {
		t.Fatalf("twitter rule = %+v", o)
	}
}

// The WebUI sees hints of the tokens; what it sends back keeps the stored
// token by the worker's id, wherever the worker moved in the list.
func TestWorkerTokensStayOutOfTheWebUI(t *testing.T) {
	stored := withFetcher()
	sent := stored.Redacted()
	if w := sent.Fetchers[0].Workers[0]; w.Token != "" || w.TokenHint == "" {
		t.Fatalf("redacted worker = %+v", w)
	}
	back := sent.Clone()
	ws := back.Fetchers[0].Workers
	ws[0], ws[1] = ws[1], ws[0]
	ws = append(ws, Worker{ID: "w3", Token: "token-three"})
	back.Fetchers[0].Workers = ws
	back.MergeSecrets(stored)
	got := back.Fetchers[0].Workers
	if got[0].Token != "token-two" || got[1].Token != "token-one" || got[2].Token != "token-three" || got[0].TokenHint != "" {
		t.Fatalf("merged workers = %+v", got)
	}
	if f, w, ok := back.WorkerByToken("token-two"); !ok || f.ID != "home" || w.ID != "w2" {
		t.Fatalf("WorkerByToken = %v, %v, %v", f, w, ok)
	}
	if _, _, ok := back.WorkerByToken("token"); ok {
		t.Fatal("a prefix of a token matched")
	}
}

// A name is measured in characters, as the console counts them.
func TestAFetcherNameMayBe64Characters(t *testing.T) {
	c := withFetcher()
	c.Fetchers[0].Name = strings.Repeat("长", 64)
	c.Fetchers[0].Workers[0].Name = strings.Repeat("机", 64)
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestFetcherValidation(t *testing.T) {
	for name, change := range map[string]func(c *Config){
		"id of a built-in": func(c *Config) { c.Fetchers[0].ID = "jina" },
		"engine auto":      func(c *Config) { c.Fetchers[0].ID = "auto" },
		"long name":        func(c *Config) { c.Fetchers[0].Name = strings.Repeat("长", 65) },
		"bad id":           func(c *Config) { c.Fetchers[0].ID = "Home Lab" },
		"unknown type":     func(c *Config) { c.Fetchers[0].Type = "puppeteer" },
		"bad rate limit":   func(c *Config) { c.Fetchers[0].RateLimit = "lots" },
		"no token":         func(c *Config) { c.Fetchers[0].Workers[1].Token = "" },
		"shared token":     func(c *Config) { c.Fetchers[0].Workers[1].Token = "token-one" },
		"same worker id":   func(c *Config) { c.Fetchers[0].Workers[1].ID = "w1" },
		"same fetcher id": func(c *Config) {
			c.Fetchers = append(c.Fetchers, Fetcher{ID: "home", Type: FetcherOpenCLI, Workers: []Worker{}})
		},
	} {
		c := withFetcher()
		change(c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: no error", name)
		} else if strings.Contains(err.Error(), "token-") {
			t.Errorf("%s: the error shows a token: %v", name, err)
		}
	}
}
