// Package config defines the runtime configuration document. The document is
// stored as a whole in SQLite and is the single source of truth; YAML is only
// an import/export format.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

const (
	ToolSearch   = "search"
	ToolFetch    = "fetch"
	ToolResearch = "research"

	LLMOpenAICompatible = "openai-compatible"
	LLMAnthropic        = "anthropic"
)

// Tools lists every tool an API key can be scoped to.
var Tools = []string{ToolSearch, ToolFetch, ToolResearch}

type Config struct {
	Providers map[string]*Provider `json:"providers"`
	Search    Search               `json:"search"`
	Fetch     Fetch                `json:"fetch"`
	LLM       LLM                  `json:"llm"`
	Research  Research             `json:"research"`
	Breaker   Breaker              `json:"breaker"`
	Logs      Logs                 `json:"logs"`
	Network   Network              `json:"network"`
}

// Secret is the API key part shared by search/fetch providers and LLM
// providers. APIKeyHint is only set on documents sent to the WebUI, and
// ClearAPIKey only on documents received from it.
type Secret struct {
	APIKey      string `json:"api_key"`
	APIKeyHint  string `json:"api_key_hint,omitempty"`
	ClearAPIKey bool   `json:"clear_api_key,omitempty"`
}

// Provider holds the credentials of one search/fetch provider.
type Provider struct {
	Secret
	BaseURL string `json:"base_url,omitempty"`
}

// Route binds a provider to a tool. The position in the list is the priority.
type Route struct {
	Provider    string `json:"provider"`
	Enabled     bool   `json:"enabled"`
	RateLimit   string `json:"rate_limit"`
	Concurrency int    `json:"concurrency"`
	// Options holds the provider's parameters for this tool that differ from
	// the defaults its catalog entry declares.
	Options map[string]any `json:"options,omitempty"`
	// ExtraBody is merged into the request last, so it overrides Options and
	// reaches parameters that have no option. It is the JSON body, or the
	// query string or headers of a provider that takes its parameters there.
	ExtraBody map[string]any `json:"extra_body,omitempty"`
}

type Search struct {
	TimeoutSeconds float64 `json:"timeout_seconds"`
	// Country and Language localize results on every provider that can; a
	// route's own option overrides them.
	Country  string  `json:"country,omitempty"`
	Language string  `json:"language,omitempty"`
	Routes   []Route `json:"routes"`
}

type Fetch struct {
	TimeoutSeconds       float64 `json:"timeout_seconds"`
	SlowThresholdSeconds float64 `json:"slow_threshold_seconds"`
	SmartFallback        bool    `json:"smart_fallback"`
	CacheTTLSeconds      int     `json:"cache_ttl_seconds"`
	PassthroughLength    int     `json:"passthrough_length"`
	RawPageLength        int     `json:"raw_page_length"`
	Routes               []Route `json:"routes"`
	Extract              Extract `json:"extract"`
}

// Extract configures the helper models that answer a fetch prompt from a page.
type Extract struct {
	// Models lists model ids in priority order: a model that fails or is rate
	// limited hands the request to the next one.
	Models []string `json:"models"`
	// RawOnFailure returns the page text when no model can answer, without
	// waiting for a rate-limit slot, instead of an error.
	RawOnFailure   bool   `json:"raw_on_failure"`
	SystemPrompt   string `json:"system_prompt,omitempty"`
	MaxInputLength int    `json:"max_input_length"`
	// MaxOutputTokens caps an answer below the model's own limit; 0 leaves
	// the model's.
	MaxOutputTokens      int64 `json:"max_output_tokens,omitempty"`
	FirstChunkTimeoutMs  int   `json:"first_chunk_timeout_ms"`
	MaxRetries           int   `json:"max_retries"`
	StreamTotalTimeoutMs int   `json:"stream_total_timeout_ms"`
}

func (e Extract) Configured() bool { return len(e.Models) > 0 }

type LLM struct {
	Providers []LLMProvider `json:"providers"`
}

// LLMProvider is one model API endpoint and the models used from it.
type LLMProvider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	Secret
	BaseURL string            `json:"base_url"`
	Headers map[string]string `json:"headers,omitempty"`
	Models  []Model           `json:"models"`
}

// Model is a model of an LLM provider together with everything that belongs
// to the model rather than to a feature using it. Features refer to it by ID,
// which is unique across all providers; the same upstream model may appear
// under several ids with different parameters.
type Model struct {
	ID string `json:"id"`
	// Name is the model name sent to the API.
	Name            string    `json:"name"`
	MaxOutputTokens int64     `json:"max_output_tokens,omitempty"`
	Reasoning       Reasoning `json:"reasoning"`
	// ExtraBody is merged into the request last, so it overrides Reasoning.
	ExtraBody map[string]any `json:"extra_body,omitempty"`
	// RateLimit and Concurrency are shared by every feature using the model.
	RateLimit   string `json:"rate_limit"`
	Concurrency int    `json:"concurrency"`
}

const (
	// ReasoningDefault sends nothing and leaves reasoning to the model.
	ReasoningDefault = ""
	ReasoningOff     = "off"
	// ReasoningEffort picks a level: reasoning_effort on OpenAI-compatible
	// APIs, adaptive thinking with an effort on Anthropic.
	ReasoningEffort = "effort"
	// ReasoningBudget gives Anthropic thinking a fixed token budget.
	ReasoningBudget = "budget"
)

// ReasoningEfforts lists the effort levels each API format accepts.
var ReasoningEfforts = map[string][]string{
	LLMOpenAICompatible: {"minimal", "low", "medium", "high", "xhigh"},
	LLMAnthropic:        {"low", "medium", "high", "xhigh", "max"},
}

// Reasoning says how much a model should think before answering.
type Reasoning struct {
	Mode         string `json:"mode"`
	Effort       string `json:"effort,omitempty"`
	BudgetTokens int64  `json:"budget_tokens,omitempty"`
}

func (r Reasoning) validate(apiType string) error {
	switch r.Mode {
	case ReasoningDefault, ReasoningOff:
	case ReasoningEffort:
		if !slices.Contains(ReasoningEfforts[apiType], r.Effort) {
			return fmt.Errorf("reasoning effort %q is not one of %s", r.Effort, strings.Join(ReasoningEfforts[apiType], ", "))
		}
	case ReasoningBudget:
		if apiType != LLMAnthropic {
			return errors.New("a reasoning token budget is only available on the Anthropic format")
		}
		if r.BudgetTokens < 1024 {
			return errors.New("the reasoning token budget must be at least 1024")
		}
	default:
		return fmt.Errorf("unknown reasoning mode %q", r.Mode)
	}
	return nil
}

// Research configures the research agent. It runs on a single model: a run
// builds on the provider's prompt cache, so it does not fail over.
type Research struct {
	Enabled bool   `json:"enabled"`
	Model   string `json:"model"`
	// Reading is how the agent reads pages: ReadingRaw gives it the page text,
	// ReadingExtract has the extract models answer its question about the page.
	Reading            string `json:"reading"`
	SystemPrompt       string `json:"system_prompt,omitempty"`
	MaxSteps           int    `json:"max_steps"`
	MaxDurationSeconds int    `json:"max_duration_seconds"`
	MaxTokens          int64  `json:"max_tokens"`
	// MaxContextTokens bounds a single request to the model, where MaxTokens
	// bounds the sum over all steps.
	MaxContextTokens int64 `json:"max_context_tokens"`
}

const (
	ReadingRaw     = "raw"
	ReadingExtract = "extract"
)

func (r Research) Configured() bool { return r.Model != "" }

// Breaker is the one circuit-breaker policy for every search and fetch
// provider and every extract model: after Failures failures in a row within
// WindowSeconds it is skipped for CooldownSeconds.
type Breaker struct {
	Enabled         bool `json:"enabled"`
	Failures        int  `json:"failures"`
	WindowSeconds   int  `json:"window_seconds"`
	CooldownSeconds int  `json:"cooldown_seconds"`
}

type Logs struct {
	RetentionDays int  `json:"retention_days"`
	MaxRows       int  `json:"max_rows"`
	CaptureBody   bool `json:"capture_body"`
}

type Network struct {
	// Proxy is an outbound proxy URL (http, https or socks5). Empty means the
	// process environment decides.
	Proxy string `json:"proxy,omitempty"`
}

// ProviderInfo describes a built-in search/fetch provider.
type ProviderInfo struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Website     string            `json:"website"`
	KeyRequired bool              `json:"key_required"`
	DefaultBase map[string]string `json:"default_base_url"`
	// DefaultRateLimit is keyed by tool; a missing tool means unsupported.
	DefaultRateLimit map[string]string `json:"default_rate_limit"`
	// Options is keyed by tool.
	Options map[string][]Option `json:"options,omitempty"`
}

func (p ProviderInfo) Supports(tool string) bool {
	_, ok := p.DefaultRateLimit[tool]
	return ok
}

// Catalog lists the built-in providers in default priority order.
var Catalog = []ProviderInfo{
	{
		ID: "brave", Name: "Brave Search", Website: "https://api-dashboard.search.brave.com", KeyRequired: true,
		DefaultBase:      map[string]string{ToolSearch: "https://api.search.brave.com"},
		DefaultRateLimit: map[string]string{ToolSearch: "1/s"},
		Options: map[string][]Option{ToolSearch: {
			{Key: "extra_snippets", Type: OptionBool, Default: false},
			{Key: "safesearch", Type: OptionEnum, Default: "moderate", Values: []string{"off", "moderate", "strict"}},
			{Key: "goggles", Type: OptionString, Default: ""},
			optCountry, optLanguage,
		}},
	},
	{
		ID: "exa", Name: "Exa", Website: "https://dashboard.exa.ai", KeyRequired: true,
		DefaultBase:      map[string]string{ToolSearch: "https://api.exa.ai", ToolFetch: "https://api.exa.ai"},
		DefaultRateLimit: map[string]string{ToolSearch: "10/s", ToolFetch: "10/s"},
		Options: map[string][]Option{
			ToolSearch: {
				{Key: "type", Type: OptionEnum, Default: "auto", Values: []string{"instant", "fast", "auto", "deep-lite", "deep"}},
				{Key: "contents", Type: OptionEnum, Default: "highlights", Values: []string{"highlights", "text", "summary"}},
				{Key: "max_characters", Type: OptionInt, Default: 600, Min: 1, Max: 100000},
				{Key: "max_age_hours", Type: OptionInt, Min: -1, Max: 720},
				optCountry,
			},
			ToolFetch: {
				{Key: "verbosity", Type: OptionEnum, Default: "compact", Values: []string{"compact", "standard", "full"}},
				{Key: "max_age_hours", Type: OptionInt, Min: -1, Max: 720},
				{Key: "livecrawl_timeout_ms", Type: OptionInt, Default: 10000, Min: 1000, Max: 90000},
			},
		},
	},
	{
		ID: "perplexity", Name: "Perplexity", Website: "https://console.perplexity.ai", KeyRequired: true,
		DefaultBase:      map[string]string{ToolSearch: "https://api.perplexity.ai"},
		DefaultRateLimit: map[string]string{ToolSearch: "50/s"},
		Options: map[string][]Option{ToolSearch: {
			{Key: "search_type", Type: OptionEnum, Default: "web", Values: []string{"web", "fast"}},
			{Key: "max_tokens_per_page", Type: OptionInt, Default: 256, Min: 1, Max: 1000000},
			{Key: "max_tokens", Type: OptionInt, Min: 1, Max: 1000000},
			optCountry, optLanguage,
		}},
	},
	{
		ID: "tavily", Name: "Tavily", Website: "https://app.tavily.com", KeyRequired: true,
		DefaultBase:      map[string]string{ToolSearch: "https://api.tavily.com", ToolFetch: "https://api.tavily.com"},
		DefaultRateLimit: map[string]string{ToolSearch: "5/m", ToolFetch: "5/m"},
		Options: map[string][]Option{
			ToolSearch: {
				{Key: "search_depth", Type: OptionEnum, Default: "advanced", Values: []string{"basic", "advanced", "fast", "ultra-fast"}},
				{Key: "chunks_per_source", Type: OptionInt, Default: 3, Min: 1, Max: 3},
				{Key: "topic", Type: OptionEnum, Default: "general", Values: []string{"general", "news", "finance"}},
				optCountry, optLanguage,
			},
			ToolFetch: {
				{Key: "extract_depth", Type: OptionEnum, Default: "basic", Values: []string{"basic", "advanced"}},
			},
		},
	},
	{
		ID: "jina", Name: "Jina Reader", Website: "https://jina.ai/reader", KeyRequired: false,
		DefaultBase:      map[string]string{ToolFetch: "https://r.jina.ai"},
		DefaultRateLimit: map[string]string{ToolFetch: "5/m"},
		Options: map[string][]Option{ToolFetch: {
			{Key: "engine", Type: OptionEnum, Default: "auto", Values: []string{"auto", "browser", "curl"}},
			{Key: "retain_images", Type: OptionEnum, Default: "none", Values: []string{"all", "alt", "none"}},
			{Key: "cache_tolerance_seconds", Type: OptionInt, Min: 0, Max: 2592000},
			{Key: "proxy_country", Type: OptionString, Default: "", Format: FormatCountry},
		}},
	},
	{
		ID: "firecrawl", Name: "Firecrawl", Website: "https://www.firecrawl.dev/app", KeyRequired: true,
		DefaultBase:      map[string]string{ToolSearch: "https://api.firecrawl.dev", ToolFetch: "https://api.firecrawl.dev"},
		DefaultRateLimit: map[string]string{ToolSearch: "5/m", ToolFetch: "5/m"},
		Options: map[string][]Option{
			ToolSearch: {
				{Key: "highlights", Type: OptionBool, Default: true},
				optCountry,
			},
			ToolFetch: {
				{Key: "max_age_hours", Type: OptionInt, Default: 48, Min: 0, Max: 17520},
				{Key: "proxy", Type: OptionEnum, Default: "auto", Values: []string{"auto", "basic", "enhanced"}},
				{Key: "wait_for_ms", Type: OptionInt, Default: 0, Min: 0, Max: 60000},
				{Key: "only_main_content", Type: OptionBool, Default: true},
				{Key: "pdf_mode", Type: OptionEnum, Default: "auto", Values: []string{"auto", "fast", "ocr"}},
				{Key: "pdf_max_pages", Type: OptionInt, Min: 1, Max: 10000},
				optCountry,
			},
		},
	},
}

func Info(id string) (ProviderInfo, bool) {
	for _, p := range Catalog {
		if p.ID == id {
			return p, true
		}
	}
	return ProviderInfo{}, false
}

func defaultRoutes(tool string, order ...string) []Route {
	var routes []Route
	for _, id := range order {
		info, _ := Info(id)
		routes = append(routes, Route{Provider: id, Enabled: true, RateLimit: info.DefaultRateLimit[tool]})
	}
	return routes
}

// Default returns the configuration of a fresh install.
func Default() *Config {
	c := &Config{
		Search: Search{TimeoutSeconds: 10, Routes: defaultRoutes(ToolSearch, "brave", "exa", "perplexity", "tavily", "firecrawl")},
		Fetch: Fetch{
			TimeoutSeconds:       30,
			SlowThresholdSeconds: 15,
			SmartFallback:        true,
			CacheTTLSeconds:      300,
			PassthroughLength:    4000,
			RawPageLength:        40000,
			Routes:               defaultRoutes(ToolFetch, "jina", "firecrawl", "tavily", "exa"),
			Extract: Extract{
				RawOnFailure:         true,
				MaxInputLength:       150000,
				FirstChunkTimeoutMs:  10000,
				MaxRetries:           3,
				StreamTotalTimeoutMs: 60000,
			},
		},
		Research: Research{Reading: ReadingRaw, MaxSteps: 24, MaxDurationSeconds: 420, MaxTokens: 600000, MaxContextTokens: 150000},
		Breaker:  Breaker{Enabled: true, Failures: 3, WindowSeconds: 60, CooldownSeconds: 60},
		Logs:     Logs{RetentionDays: 14, MaxRows: 20000, CaptureBody: true},
	}
	c.Normalize()
	return c
}

// Normalize fills in everything a hand-written or older document may omit so
// the rest of the program can rely on a complete document.
func (c *Config) Normalize() {
	if c.Providers == nil {
		c.Providers = map[string]*Provider{}
	}
	for _, info := range Catalog {
		if c.Providers[info.ID] == nil {
			c.Providers[info.ID] = &Provider{}
		}
	}
	for id, p := range c.Providers {
		if _, ok := Info(id); !ok {
			delete(c.Providers, id)
			continue
		}
		p.APIKey = strings.TrimSpace(p.APIKey)
		p.BaseURL = strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
	}

	c.Search.Country = cleanFormat(FormatCountry, c.Search.Country)
	c.Search.Language = cleanFormat(FormatLanguage, c.Search.Language)
	c.Search.Routes = normalizeRoutes(ToolSearch, c.Search.Routes)
	c.Fetch.Routes = normalizeRoutes(ToolFetch, c.Fetch.Routes)

	d := struct{ s, f, slow float64 }{10, 30, 15}
	if c.Search.TimeoutSeconds <= 0 {
		c.Search.TimeoutSeconds = d.s
	}
	if c.Fetch.TimeoutSeconds <= 0 {
		c.Fetch.TimeoutSeconds = d.f
	}
	if c.Fetch.SlowThresholdSeconds <= 0 {
		c.Fetch.SlowThresholdSeconds = d.slow
	}
	positive(&c.Fetch.CacheTTLSeconds, 300)
	positive(&c.Fetch.PassthroughLength, 4000)
	positive(&c.Fetch.RawPageLength, 40000)
	positive(&c.Fetch.Extract.MaxInputLength, 150000)
	c.Fetch.Extract.MaxOutputTokens = max(c.Fetch.Extract.MaxOutputTokens, 0)
	positive(&c.Fetch.Extract.FirstChunkTimeoutMs, 10000)
	positive(&c.Fetch.Extract.MaxRetries, 3)
	positive(&c.Fetch.Extract.StreamTotalTimeoutMs, 60000)
	if c.Research.Reading != ReadingExtract {
		c.Research.Reading = ReadingRaw
	}
	positive(&c.Research.MaxSteps, 24)
	positive(&c.Research.MaxDurationSeconds, 420)
	if c.Research.MaxTokens <= 0 {
		c.Research.MaxTokens = 600000
	}
	if c.Research.MaxContextTokens <= 0 {
		c.Research.MaxContextTokens = 150000
	}
	positive(&c.Breaker.Failures, 3)
	positive(&c.Breaker.WindowSeconds, 60)
	positive(&c.Breaker.CooldownSeconds, 60)
	positive(&c.Logs.RetentionDays, 14)
	positive(&c.Logs.MaxRows, 20000)

	if c.LLM.Providers == nil {
		c.LLM.Providers = []LLMProvider{}
	}
	for i := range c.LLM.Providers {
		p := &c.LLM.Providers[i]
		p.ID = strings.TrimSpace(p.ID)
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" {
			p.Name = p.ID
		}
		p.APIKey = strings.TrimSpace(p.APIKey)
		p.BaseURL = strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
		if p.Models == nil {
			p.Models = []Model{}
		}
		for j := range p.Models {
			m := &p.Models[j]
			m.ID, m.Name = strings.TrimSpace(m.ID), strings.TrimSpace(m.Name)
			m.RateLimit = strings.TrimSpace(m.RateLimit)
			m.Concurrency = max(m.Concurrency, 0)
			// Keep only what the chosen mode uses.
			if m.Reasoning.Mode != ReasoningEffort {
				m.Reasoning.Effort = ""
			}
			if m.Reasoning.Mode != ReasoningBudget {
				m.Reasoning.BudgetTokens = 0
			}
		}
	}
	if c.Fetch.Extract.Models == nil {
		c.Fetch.Extract.Models = []string{}
	}
	c.Research.Model = strings.TrimSpace(c.Research.Model)
	c.Network.Proxy = strings.TrimSpace(c.Network.Proxy)
}

func positive(v *int, fallback int) {
	if *v <= 0 {
		*v = fallback
	}
}

// normalizeRoutes drops unknown or duplicate routes and appends, disabled, any
// provider that supports the tool but has no route yet.
func normalizeRoutes(tool string, routes []Route) []Route {
	out := make([]Route, 0, len(Catalog))
	seen := map[string]bool{}
	for _, r := range routes {
		info, ok := Info(r.Provider)
		if !ok || !info.Supports(tool) || seen[r.Provider] {
			continue
		}
		seen[r.Provider] = true
		r.RateLimit = strings.TrimSpace(r.RateLimit)
		if r.Concurrency < 0 {
			r.Concurrency = 0
		}
		normalizeOptions(tool, &r)
		out = append(out, r)
	}
	for _, info := range Catalog {
		if info.Supports(tool) && !seen[info.ID] {
			out = append(out, Route{Provider: info.ID, RateLimit: info.DefaultRateLimit[tool]})
		}
	}
	return out
}

var (
	idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
	// Model ids are usually the model name, which may contain dots.
	modelIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
)

// Validate reports the first problem that would make the document unusable.
// It expects a normalized document.
func (c *Config) Validate() error {
	for _, tool := range []struct {
		name   string
		routes []Route
	}{{ToolSearch, c.Search.Routes}, {ToolFetch, c.Fetch.Routes}} {
		for _, r := range tool.routes {
			if _, err := ParseRateLimit(r.RateLimit); err != nil {
				return fmt.Errorf("%s route %q: %w", tool.name, r.Provider, err)
			}
			if err := validateOptions(tool.name, r); err != nil {
				return fmt.Errorf("%s route %q: %w", tool.name, r.Provider, err)
			}
		}
	}
	if err := checkFormat(FormatCountry, c.Search.Country); err != nil {
		return fmt.Errorf("search.country: %w", err)
	}
	if err := checkFormat(FormatLanguage, c.Search.Language); err != nil {
		return fmt.Errorf("search.language: %w", err)
	}
	for id, p := range c.Providers {
		if err := checkURL(p.BaseURL, "http", "https"); err != nil {
			return fmt.Errorf("provider %q base_url: %w", id, err)
		}
	}

	ids, models := map[string]bool{}, map[string]bool{}
	for _, p := range c.LLM.Providers {
		if !idPattern.MatchString(p.ID) {
			return fmt.Errorf("llm provider id %q must be lowercase letters, digits, - or _", p.ID)
		}
		if ids[p.ID] {
			return fmt.Errorf("llm provider id %q is used twice", p.ID)
		}
		ids[p.ID] = true
		if p.Type != LLMOpenAICompatible && p.Type != LLMAnthropic {
			return fmt.Errorf("llm provider %q: type must be %q or %q", p.ID, LLMOpenAICompatible, LLMAnthropic)
		}
		if p.Type == LLMOpenAICompatible && p.BaseURL == "" {
			return fmt.Errorf("llm provider %q: base_url is required", p.ID)
		}
		if err := checkURL(p.BaseURL, "http", "https"); err != nil {
			return fmt.Errorf("llm provider %q base_url: %w", p.ID, err)
		}
		for _, m := range p.Models {
			if !modelIDPattern.MatchString(m.ID) {
				return fmt.Errorf("model id %q must be lowercase letters, digits, ., - or _", m.ID)
			}
			if models[m.ID] {
				return fmt.Errorf("model id %q is used twice", m.ID)
			}
			models[m.ID] = true
			if m.Name == "" {
				return fmt.Errorf("model %q: the model name is required", m.ID)
			}
			if _, err := ParseRateLimit(m.RateLimit); err != nil {
				return fmt.Errorf("model %q: %w", m.ID, err)
			}
			if err := m.Reasoning.validate(p.Type); err != nil {
				return fmt.Errorf("model %q: %w", m.ID, err)
			}
		}
	}
	seen := map[string]bool{}
	for _, id := range c.Fetch.Extract.Models {
		if !models[id] {
			return fmt.Errorf("fetch.extract: model %q does not exist", id)
		}
		if seen[id] {
			return fmt.Errorf("fetch.extract: model %q is listed twice", id)
		}
		seen[id] = true
	}
	if c.Research.Model != "" && !models[c.Research.Model] {
		return fmt.Errorf("research: model %q does not exist", c.Research.Model)
	}
	if c.Research.Enabled && !c.Research.Configured() {
		return fmt.Errorf("research is enabled but has no model")
	}
	if err := checkURL(c.Network.Proxy, "http", "https", "socks5", "socks5h"); err != nil {
		return fmt.Errorf("network.proxy: %w", err)
	}
	return nil
}

func checkURL(raw string, schemes ...string) error {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || !slices.Contains(schemes, u.Scheme) {
		return fmt.Errorf("%q is not a valid %s URL", raw, strings.Join(schemes, "/"))
	}
	return nil
}

// LLMProviderByID returns the LLM provider with the given id.
func (c *Config) LLMProviderByID(id string) (LLMProvider, bool) {
	for _, p := range c.LLM.Providers {
		if p.ID == id {
			return p, true
		}
	}
	return LLMProvider{}, false
}

// ModelByID returns the model with the given id and the provider it belongs to.
func (c *Config) ModelByID(id string) (LLMProvider, Model, bool) {
	for _, p := range c.LLM.Providers {
		for _, m := range p.Models {
			if m.ID == id {
				return p, m, true
			}
		}
	}
	return LLMProvider{}, Model{}, false
}

// Clone returns a deep copy.
func (c *Config) Clone() *Config {
	data, err := json.Marshal(c)
	if err != nil {
		panic(err)
	}
	var out Config
	if err := json.Unmarshal(data, &out); err != nil {
		panic(err)
	}
	return &out
}

func hint(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return "••••"
	}
	return "••••" + key[len(key)-4:]
}

// Redacted returns a copy safe to send to the WebUI: keys are replaced by hints.
func (c *Config) Redacted() *Config {
	out := c.Clone()
	for _, p := range out.Providers {
		p.APIKeyHint, p.APIKey = hint(p.APIKey), ""
	}
	for i := range out.LLM.Providers {
		p := &out.LLM.Providers[i]
		p.APIKeyHint, p.APIKey = hint(p.APIKey), ""
	}
	return out
}

func (s *Secret) merge(current string) {
	switch {
	case s.ClearAPIKey:
		s.APIKey = ""
	case strings.TrimSpace(s.APIKey) == "":
		s.APIKey = current
	}
	s.APIKeyHint, s.ClearAPIKey = "", false
}

// MergeSecrets resolves a document coming from the WebUI against the current
// one: an empty key keeps the stored key unless clear_api_key is set.
func (c *Config) MergeSecrets(current *Config) {
	for id, p := range c.Providers {
		if p == nil {
			continue
		}
		var existing string
		if cur := current.Providers[id]; cur != nil {
			existing = cur.APIKey
		}
		p.merge(existing)
	}
	for i := range c.LLM.Providers {
		p := &c.LLM.Providers[i]
		cur, _ := current.LLMProviderByID(p.ID)
		p.merge(cur.APIKey)
	}
}
