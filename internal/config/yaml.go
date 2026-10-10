package config

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/goccy/go-yaml"
)

// ToYAML renders the document, secrets included, for backup or migration.
func (c *Config) ToYAML() ([]byte, error) {
	data, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	return yaml.JSONToYAML(data)
}

// FromYAML parses an exported document. Unknown fields are rejected so a typo
// does not silently fall back to a default.
func FromYAML(data []byte) (*Config, error) {
	raw, err := yaml.YAMLToJSON(data)
	if err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}
	return FromJSON(raw)
}

// FromJSON parses a document and normalizes and validates it.
func FromJSON(data []byte) (*Config, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	var c Config
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	c.Normalize()
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

// FromStored reads the document kept in the database. Unlike an import it
// tolerates unknown fields, so a database written by a newer version still opens.
func FromStored(data []byte) (*Config, error) {
	c := Default()
	if err := json.Unmarshal(data, c); err != nil {
		return nil, err
	}
	c.Normalize()
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return c, nil
}

// FromLegacyEnv builds a document from the .env file of the stdio-based
// search-mcp this project replaces.
func FromLegacyEnv(r io.Reader) (*Config, error) {
	env := map[string]string{}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(strings.TrimPrefix(line, "export "), "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		env[strings.TrimSpace(key)] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	c := Default()
	for id, key := range map[string]string{
		"brave": "BRAVE_API_KEY", "exa": "EXA_API_KEY", "perplexity": "PERPLEXITY_API_KEY",
		"tavily": "TAVILY_API_KEY", "jina": "JINA_API_KEY", "firecrawl": "FIRECRAWL_API_KEY",
	} {
		c.Providers[id].APIKey = env[key]
	}

	c.Search.Routes = legacyRoutes(env, ToolSearch, "SEARCH_PROVIDERS", c.Search.Routes)
	c.Fetch.Routes = legacyRoutes(env, ToolFetch, "FETCH_PROVIDERS", c.Fetch.Routes)
	// The file states limits per route; Normalize folds them into the providers.
	for _, p := range c.Providers {
		p.RateLimit, p.Concurrency = nil, 0
	}

	legacyFloat(env, "SEARCH_TIMEOUT", &c.Search.TimeoutSeconds)
	legacyFloat(env, "FETCH_TIMEOUT", &c.Fetch.TimeoutSeconds)
	legacyFloat(env, "FETCH_SLOW_THRESHOLD", &c.Fetch.SlowThresholdSeconds)
	legacyInt(env, "FETCH_CACHE_TTL", &c.Fetch.CacheTTLSeconds)
	legacyInt(env, "FETCH_PASSTHROUGH_LENGTH", &c.Fetch.PassthroughLength)
	legacyInt(env, "FETCH_RAW_PAGE_LENGTH", &c.Fetch.RawPageLength)
	if v := env["FETCH_SMART_FALLBACK"]; v == "false" || v == "0" {
		c.Fetch.SmartFallback = false
	}

	if env["EXTRACT_API_KEY"] != "" && env["EXTRACT_API_BASE"] != "" && env["EXTRACT_MODEL"] != "" {
		c.LLM.Providers = append(c.LLM.Providers, LLMProvider{
			ID: "extract", Name: "Extract", Type: LLMOpenAICompatible,
			Secret: Secret{APIKey: env["EXTRACT_API_KEY"]}, BaseURL: env["EXTRACT_API_BASE"],
		})
		model := Model{ID: ModelID(env["EXTRACT_MODEL"]), Name: env["EXTRACT_MODEL"]}
		if raw := env["EXTRACT_EXTRA_BODY"]; raw != "" {
			if err := json.Unmarshal([]byte(raw), &model.ExtraBody); err != nil {
				return nil, fmt.Errorf("EXTRACT_EXTRA_BODY is not a JSON object: %w", err)
			}
		}
		c.LLM.Providers[len(c.LLM.Providers)-1].Models = []Model{model}
		ex := &c.Fetch.Extract
		ex.Models = []string{model.ID}
		ex.SystemPrompt = env["EXTRACT_SYSTEM_PROMPT"]
		legacyInt(env, "EXTRACT_MAX_INPUT_LENGTH", &ex.MaxInputLength)
		legacyInt(env, "EXTRACT_FIRST_CHUNK_TIMEOUT_MS", &ex.FirstChunkTimeoutMs)
		legacyInt(env, "EXTRACT_MAX_RETRIES", &ex.MaxRetries)
		legacyInt(env, "EXTRACT_STREAM_TOTAL_TIMEOUT_MS", &ex.StreamTotalTimeoutMs)
	}

	for _, name := range []string{"SOCKS_PROXY", "ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY"} {
		if v := env[name]; v != "" {
			c.Network.Proxy = v
			break
		}
	}

	c.Normalize()
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return c, nil
}

var notModelID = regexp.MustCompile(`[^a-z0-9._-]+`)

// ModelID derives a model id from a model name, e.g. "openai/GPT-5" becomes
// "openai-gpt-5".
func ModelID(name string) string {
	id := strings.Trim(notModelID.ReplaceAllString(strings.ToLower(name), "-"), "-._")
	if len(id) > 64 {
		id = id[:64]
	}
	if id == "" {
		id = "model"
	}
	return id
}

func legacyRoutes(env map[string]string, tool, orderKey string, defaults []Route) []Route {
	routes := defaults
	if order := env[orderKey]; order != "" {
		routes = nil
		for _, id := range strings.Split(order, ",") {
			routes = append(routes, Route{Provider: strings.TrimSpace(id), Enabled: true})
		}
		routes = normalizeRoutes(tool, routes)
	}
	for i := range routes {
		r := &routes[i]
		prefix := strings.ToUpper(r.Provider) + "_" + strings.ToUpper(tool)
		if v := env[prefix+"_RATE_LIMIT"]; v != "" {
			r.LegacyRateLimit = &v
		}
		if n, err := strconv.Atoi(env[prefix+"_CONCURRENCY"]); err == nil && n > 0 {
			r.LegacyConcurrency = &n
		}
	}
	return routes
}

func legacyFloat(env map[string]string, key string, target *float64) {
	if v, err := strconv.ParseFloat(env[key], 64); err == nil && v > 0 {
		*target = v
	}
}

func legacyInt(env map[string]string, key string, target *int) {
	if v, err := strconv.ParseFloat(env[key], 64); err == nil && v > 0 {
		*target = int(v)
	}
}
