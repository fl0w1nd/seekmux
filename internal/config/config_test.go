package config

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestParseRateLimit(t *testing.T) {
	cases := map[string]RateLimit{
		"":       {},
		"1/s":    {1, time.Second},
		"15/m":   {15, time.Minute},
		"10/10s": {10, 10 * time.Second},
		"100/2h": {100, 2 * time.Hour},
	}
	for in, want := range cases {
		got, err := ParseRateLimit(in)
		if err != nil || got != want {
			t.Errorf("ParseRateLimit(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"1", "1/d", "0/s", "1/0s", "-1/s", "a/s"} {
		if _, err := ParseRateLimit(bad); err == nil {
			t.Errorf("ParseRateLimit(%q) should fail", bad)
		}
	}
}

func TestDefaultIsValidAndComplete(t *testing.T) {
	c := Default()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(c.Search.Routes) != 4 || len(c.Fetch.Routes) != 4 || len(c.Providers) != len(Catalog) {
		t.Fatalf("routes: %d search, %d fetch, %d providers", len(c.Search.Routes), len(c.Fetch.Routes), len(c.Providers))
	}
}

func TestNormalizeRepairsRoutes(t *testing.T) {
	c := &Config{Search: Search{Routes: []Route{
		{Provider: "exa", Enabled: true}, {Provider: "exa"}, {Provider: "jina"}, {Provider: "nope"},
	}}}
	c.Normalize()
	var got []string
	for _, r := range c.Search.Routes {
		got = append(got, r.Provider)
	}
	if strings.Join(got, ",") != "exa,brave,perplexity,tavily" {
		t.Fatalf("routes = %v", got)
	}
	if c.Search.Routes[1].Enabled {
		t.Fatal("an added route must start disabled")
	}
}

func TestSecretsRoundTrip(t *testing.T) {
	stored := Default()
	stored.Providers["brave"].APIKey = "brave-secret-1234"
	stored.Providers["exa"].APIKey = "exa-secret-5678"
	stored.LLM.Providers = []LLMProvider{{ID: "main", Type: LLMOpenAICompatible, BaseURL: "https://x.test/v1", Secret: Secret{APIKey: "llm-secret-9999"}}}

	sent := stored.Redacted()
	if sent.Providers["brave"].APIKey != "" || sent.Providers["brave"].APIKeyHint != "••••1234" {
		t.Fatalf("redacted provider = %+v", sent.Providers["brave"])
	}
	if stored.Providers["brave"].APIKey == "" {
		t.Fatal("Redacted must not change the original")
	}

	// The WebUI leaves brave alone, clears exa, replaces the LLM key and
	// sets a key on tavily.
	sent.Providers["exa"].ClearAPIKey = true
	sent.Providers["tavily"].APIKey = "tavily-new"
	sent.LLM.Providers[0].APIKey = "llm-new"
	sent.MergeSecrets(stored)

	if got := sent.Providers["brave"].APIKey; got != "brave-secret-1234" {
		t.Errorf("an untouched key must be kept, got %q", got)
	}
	if got := sent.Providers["exa"].APIKey; got != "" {
		t.Errorf("a cleared key must be empty, got %q", got)
	}
	if sent.Providers["tavily"].APIKey != "tavily-new" || sent.LLM.Providers[0].APIKey != "llm-new" {
		t.Error("new keys must be stored")
	}
	if sent.Providers["brave"].APIKeyHint != "" || sent.Providers["exa"].ClearAPIKey {
		t.Error("transport fields must not be stored")
	}
}

func TestValidateRejectsBrokenReferences(t *testing.T) {
	c := Default()
	c.Fetch.Extract.Models = []string{"missing"}
	if err := c.Validate(); err == nil {
		t.Fatal("a reference to an unknown model must fail")
	}
	c = Default()
	c.LLM.Providers = []LLMProvider{
		{ID: "a", Type: LLMAnthropic, Models: []Model{{ID: "m", Name: "x"}}},
		{ID: "b", Type: LLMAnthropic, Models: []Model{{ID: "m", Name: "y"}}},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("a model id used by two providers must fail")
	}
	c = Default()
	c.Research.Enabled = true
	if err := c.Validate(); err == nil {
		t.Fatal("enabled research without a model must fail")
	}
	c = Default()
	c.Search.Routes[0].RateLimit = "fast"
	if err := c.Validate(); err == nil {
		t.Fatal("a bad rate limit must fail")
	}
}

func TestYAMLRoundTrip(t *testing.T) {
	c := Default()
	c.Providers["brave"].APIKey = "k"
	c.LLM.Providers = []LLMProvider{{ID: "a", Type: LLMAnthropic, Models: []Model{
		{ID: "m", Name: "x", RateLimit: "5/m", ExtraBody: map[string]any{"reasoning_effort": "low"}},
	}}}
	c.Fetch.Extract.Models = []string{"m"}
	data, err := c.ToYAML()
	if err != nil {
		t.Fatal(err)
	}
	back, err := FromYAML(data)
	if err != nil {
		t.Fatal(err)
	}
	if back.Providers["brave"].APIKey != "k" || len(back.Search.Routes) != 4 {
		t.Fatalf("round trip lost data: %s", data)
	}
	if _, m, ok := back.ModelByID("m"); !ok || m.RateLimit != "5/m" || m.ExtraBody["reasoning_effort"] != "low" || back.Fetch.Extract.Models[0] != "m" {
		t.Fatalf("round trip lost the model: %s", data)
	}
	if _, err := FromYAML([]byte("serach: {}\n")); err == nil {
		t.Fatal("an unknown field must be rejected")
	}
}

func TestFromLegacyEnv(t *testing.T) {
	env := `
# comment
BRAVE_API_KEY=brave-key
TAVILY_API_KEY="tavily-key"
SEARCH_PROVIDERS=tavily, brave
SEARCH_TIMEOUT=12
BRAVE_SEARCH_RATE_LIMIT=2/s
TAVILY_FETCH_RATE_LIMIT=9/m
JINA_FETCH_CONCURRENCY=3
FETCH_SMART_FALLBACK=false
FETCH_CACHE_TTL=600
EXTRACT_API_KEY=sk-x
EXTRACT_API_BASE=https://llm.test/v1/
EXTRACT_MODEL=some-model
EXTRACT_EXTRA_BODY={"reasoning_effort":"low"}
SOCKS_PROXY=socks5://127.0.0.1:1080
`
	c, err := FromLegacyEnv(strings.NewReader(env))
	if err != nil {
		t.Fatal(err)
	}
	if c.Providers["brave"].APIKey != "brave-key" || c.Providers["tavily"].APIKey != "tavily-key" {
		t.Fatal("api keys were not imported")
	}
	s := c.Search.Routes
	if s[0].Provider != "tavily" || s[1].Provider != "brave" || s[1].RateLimit != "2/s" || !s[1].Enabled || s[2].Provider != "exa" || s[2].Enabled {
		t.Fatalf("search routes = %+v", s)
	}
	if c.Search.TimeoutSeconds != 12 || c.Fetch.SmartFallback || c.Fetch.CacheTTLSeconds != 600 {
		t.Fatalf("settings were not imported: %+v", c.Fetch)
	}
	for _, r := range c.Fetch.Routes {
		if r.Provider == "tavily" && r.RateLimit != "9/m" {
			t.Errorf("tavily fetch rate limit = %q", r.RateLimit)
		}
		if r.Provider == "jina" && r.Concurrency != 3 {
			t.Errorf("jina concurrency = %d", r.Concurrency)
		}
	}
	p, m, ok := c.ModelByID("some-model")
	if !ok || p.ID != "extract" || m.Name != "some-model" || m.ExtraBody["reasoning_effort"] != "low" || c.Fetch.Extract.Models[0] != "some-model" {
		t.Fatalf("extract model = %+v, chain = %v", m, c.Fetch.Extract.Models)
	}
	if p := c.LLM.Providers[0]; p.BaseURL != "https://llm.test/v1" || p.APIKey != "sk-x" {
		t.Fatalf("llm provider = %+v", p)
	}
	if c.Network.Proxy != "socks5://127.0.0.1:1080" {
		t.Fatalf("proxy = %q", c.Network.Proxy)
	}
}

func TestReasoningIsCheckedAgainstTheAPIFormat(t *testing.T) {
	with := func(apiType string, r Reasoning) error {
		c := Default()
		c.LLM.Providers = []LLMProvider{{ID: "a", Type: apiType, BaseURL: "https://llm.test/v1", Models: []Model{{ID: "m", Name: "x", Reasoning: r}}}}
		c.Normalize()
		return c.Validate()
	}
	for _, ok := range []struct {
		apiType string
		r       Reasoning
	}{
		{LLMOpenAICompatible, Reasoning{}},
		{LLMOpenAICompatible, Reasoning{Mode: ReasoningOff}},
		{LLMOpenAICompatible, Reasoning{Mode: ReasoningEffort, Effort: "minimal"}},
		{LLMAnthropic, Reasoning{Mode: ReasoningEffort, Effort: "max"}},
		{LLMAnthropic, Reasoning{Mode: ReasoningBudget, BudgetTokens: 4096}},
	} {
		if err := with(ok.apiType, ok.r); err != nil {
			t.Errorf("%s %+v: %v", ok.apiType, ok.r, err)
		}
	}
	for _, bad := range []struct {
		apiType string
		r       Reasoning
	}{
		{LLMOpenAICompatible, Reasoning{Mode: ReasoningEffort, Effort: "max"}},
		{LLMOpenAICompatible, Reasoning{Mode: ReasoningBudget, BudgetTokens: 4096}},
		{LLMAnthropic, Reasoning{Mode: ReasoningEffort, Effort: "minimal"}},
		{LLMAnthropic, Reasoning{Mode: ReasoningBudget, BudgetTokens: 100}},
		{LLMAnthropic, Reasoning{Mode: "deep"}},
	} {
		if err := with(bad.apiType, bad.r); err == nil {
			t.Errorf("%s %+v must be rejected", bad.apiType, bad.r)
		}
	}
}

func TestRouteOptions(t *testing.T) {
	c := Default()
	route := &c.Search.Routes[0] // brave
	route.Options = map[string]any{"extra_snippets": true, "safesearch": "moderate", "country": " us ", "nope": 1.0}
	route.ExtraBody = map[string]any{}
	c.Normalize()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	route = &c.Search.Routes[0]
	// The default and the undeclared key are gone; the country is cleaned.
	if len(route.Options) != 2 || route.Options["extra_snippets"] != true || route.Options["country"] != "US" || route.ExtraBody != nil {
		t.Fatalf("options = %v, extra = %v", route.Options, route.ExtraBody)
	}
	values := OptionValues(ToolSearch, *route)
	if !values.Bool("extra_snippets") || values.Str("safesearch") != "moderate" || values.Str("goggles") != "" {
		t.Fatalf("values = %v", values)
	}

	// Stored options survive the JSON round trip of the database.
	data, _ := json.Marshal(c)
	back, err := FromStored(data)
	if err != nil || back.Search.Routes[0].Options["country"] != "US" {
		t.Fatalf("stored: %v, %v", err, back.Search.Routes[0].Options)
	}

	for _, bad := range []map[string]any{
		{"extra_snippets": "yes"}, {"safesearch": "loose"}, {"country": "USA"}, {"language": "english"},
	} {
		c := Default()
		c.Search.Routes[0].Options = bad
		c.Normalize()
		if err := c.Validate(); err == nil {
			t.Errorf("%v must be rejected", bad)
		}
	}
	c = Default()
	c.Search.Routes[1].Options = map[string]any{"max_characters": 0.0} // exa
	c.Normalize()
	if err := c.Validate(); err == nil {
		t.Error("an out-of-range number must be rejected")
	}
	c = Default()
	c.Search.Country = "china"
	c.Normalize()
	if err := c.Validate(); err == nil {
		t.Error("a bad global country must be rejected")
	}

	// An unset number is absent, not zero.
	if _, ok := OptionValues(ToolSearch, c.Search.Routes[1]).Int("max_age_hours"); ok {
		t.Error("max_age_hours must be unset by default")
	}
}
