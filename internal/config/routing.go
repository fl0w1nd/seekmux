package config

import (
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// Capability is a kind of page a provider reads where an ordinary page fetch
// does not, such as a video with its transcript. Every capability becomes a
// built-in routing rule that sends the pages it matches to the providers
// declaring it, once the rule is switched on.
type Capability struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Match lists the pages, as the patterns of a Rule.
	Match []string `json:"match"`
}

var capYouTube = Capability{
	ID: "youtube", Name: "YouTube",
	Match: []string{"youtube.com/watch", "youtube.com/shorts/", "youtube.com/live/", "youtu.be"},
}

// Rule sends the pages it matches to its own providers in place of the fetch
// routes: only those are tried, in this order. A provider serves a rule
// whenever it has its credentials, whether or not its fetch route is enabled,
// so a provider can be kept for the pages only it reads.
type Rule struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	// Match lists patterns of the form host[/path-prefix]. A host stands for
	// its subdomains as well.
	Match     []string `json:"match"`
	Providers []string `json:"providers"`
	// Builtin marks a rule that comes from a provider capability. It is never
	// set on a stored rule.
	Builtin bool `json:"builtin,omitempty"`
}

// BuiltinRule is what a document changes of a built-in rule, which is off
// until the document switches it on.
type BuiltinRule struct {
	Enabled bool `json:"enabled,omitempty"`
	// Providers replaces the rule's own list; empty keeps it.
	Providers []string `json:"providers,omitempty"`
}

// Routing holds the rules that pick the providers of a fetch by its URL. The
// built-in rules live in the catalog, so a document only states how it
// departs from them and an upgrade brings new ones by itself.
type Routing struct {
	// Rules are tried in order, ahead of the built-in ones.
	Rules []Rule `json:"rules"`
	// Builtin is keyed by the id of a built-in rule.
	Builtin map[string]BuiltinRule `json:"builtin,omitempty"`
}

// BuiltinRules derives a rule from every capability in the catalog, with the
// providers that declare it in catalog order.
func BuiltinRules() []Rule {
	var rules []Rule
	for _, info := range Catalog {
		for _, capability := range info.Capabilities {
			i := slices.IndexFunc(rules, func(r Rule) bool { return r.ID == capability.ID })
			if i < 0 {
				rules = append(rules, Rule{ID: capability.ID, Name: capability.Name, Match: capability.Match, Builtin: true})
				i = len(rules) - 1
			}
			rules[i].Providers = append(rules[i].Providers, info.ID)
		}
	}
	return rules
}

// RoutingRules returns the rules in the order they are tried: the document's
// own, then the built-in ones as the document changed them.
func (c *Config) RoutingRules() []Rule {
	rules := slices.Clone(c.Routing.Rules)
	for _, rule := range BuiltinRules() {
		if o, ok := c.Routing.Builtin[rule.ID]; ok {
			rule.Enabled = o.Enabled
			if len(o.Providers) > 0 {
				rule.Providers = o.Providers
			}
		}
		rules = append(rules, rule)
	}
	return rules
}

// RuleFor returns the first enabled rule that matches the URL.
func (c *Config) RuleFor(raw string) (Rule, bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return Rule{}, false
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	for _, rule := range c.RoutingRules() {
		if rule.Enabled && slices.ContainsFunc(rule.Match, func(p string) bool { return matchPattern(p, host, u.Path) }) {
			return rule, true
		}
	}
	return Rule{}, false
}

func matchPattern(pattern, host, path string) bool {
	domain, prefix, _ := strings.Cut(pattern, "/")
	if host != domain && !strings.HasSuffix(host, "."+domain) {
		return false
	}
	return prefix == "" || strings.HasPrefix(path, "/"+prefix)
}

// cleanPattern reduces what a person may paste, a full URL included, to
// host[/path-prefix].
func cleanPattern(raw string) string {
	p := strings.TrimSpace(raw)
	if i := strings.Index(p, "://"); i >= 0 {
		p = p[i+3:]
	}
	p, _, _ = strings.Cut(p, "?")
	p, _, _ = strings.Cut(p, "#")
	host, path, _ := strings.Cut(p, "/")
	host, _, _ = strings.Cut(strings.ToLower(host), ":")
	host = strings.TrimPrefix(strings.TrimPrefix(host, "*."), "www.")
	host = strings.TrimSuffix(host, ".")
	if path == "" {
		return host
	}
	return host + "/" + path
}

var patternHost = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$`)

func checkPattern(p string) error {
	host, _, _ := strings.Cut(p, "/")
	if !patternHost.MatchString(host) {
		return fmt.Errorf("%q is not a domain such as example.com or example.com/docs/", p)
	}
	return nil
}

// fetchProviders keeps the known fetch providers of a list, each once.
func fetchProviders(ids []string) []string {
	var out []string
	for _, id := range ids {
		if info, ok := Info(id); ok && info.Supports(ToolFetch) && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

func (c *Config) normalizeRouting() {
	rules := make([]Rule, 0, len(c.Routing.Rules))
	for _, rule := range c.Routing.Rules {
		rule.ID, rule.Name, rule.Builtin = strings.TrimSpace(rule.ID), strings.TrimSpace(rule.Name), false
		match := make([]string, 0, len(rule.Match))
		for _, raw := range rule.Match {
			if p := cleanPattern(raw); p != "" && !slices.Contains(match, p) {
				match = append(match, p)
			}
		}
		rule.Match = match
		rule.Providers = append([]string{}, fetchProviders(rule.Providers)...)
		rules = append(rules, rule)
	}
	c.Routing.Rules = rules

	builtin := BuiltinRules()
	for id, o := range c.Routing.Builtin {
		i := slices.IndexFunc(builtin, func(r Rule) bool { return r.ID == id })
		if i < 0 {
			delete(c.Routing.Builtin, id)
			continue
		}
		// What merely repeats the rule is dropped, so a provider that gains
		// the capability later reaches every document that never chose.
		o.Providers = fetchProviders(o.Providers)
		if slices.Equal(o.Providers, builtin[i].Providers) {
			o.Providers = nil
		}
		if !o.Enabled && len(o.Providers) == 0 {
			delete(c.Routing.Builtin, id)
			continue
		}
		c.Routing.Builtin[id] = o
	}
	if len(c.Routing.Builtin) == 0 {
		c.Routing.Builtin = nil
	}
}

func (c *Config) validateRouting() error {
	seen := map[string]bool{}
	for _, rule := range BuiltinRules() {
		seen[rule.ID] = true
	}
	for _, rule := range c.Routing.Rules {
		if !idPattern.MatchString(rule.ID) {
			return fmt.Errorf("routing rule id %q must be lowercase letters, digits, - or _", rule.ID)
		}
		if seen[rule.ID] {
			return fmt.Errorf("routing rule id %q is used twice", rule.ID)
		}
		seen[rule.ID] = true
		if rule.Name == "" || len(rule.Name) > 64 {
			return fmt.Errorf("routing rule %q: a name is required, at most 64 characters", rule.ID)
		}
		if len(rule.Match) == 0 {
			return fmt.Errorf("routing rule %q: list at least one domain", rule.Name)
		}
		for _, p := range rule.Match {
			if err := checkPattern(p); err != nil {
				return fmt.Errorf("routing rule %q: %w", rule.Name, err)
			}
		}
		if len(rule.Providers) == 0 {
			return fmt.Errorf("routing rule %q: choose at least one provider", rule.Name)
		}
	}
	return nil
}
