package config

import (
	"slices"
	"strings"
	"testing"
)

func TestYouTubeIsRoutedToTheProvidersThatReadItOnceSwitchedOn(t *testing.T) {
	// A document stored before routing existed gets the built-in rules,
	// switched off: an upgrade changes nothing by itself.
	c, err := FromStored([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if rules := c.RoutingRules(); len(rules) != 1 || rules[0].ID != "youtube" || rules[0].Enabled {
		t.Fatalf("rules = %+v", rules)
	}
	if _, ok := c.RuleFor("https://youtu.be/aircAruvnKk"); ok {
		t.Fatal("a built-in rule must not match until it is switched on")
	}
	c.Routing.Builtin = map[string]BuiltinRule{"youtube": {Enabled: true}}
	for url, want := range map[string]bool{
		"https://www.youtube.com/watch?v=aircAruvnKk": true,
		"https://m.youtube.com/shorts/aircAruvnKk":    true,
		"https://youtube.com/live/aircAruvnKk?t=3":    true,
		"https://youtu.be/aircAruvnKk":                true,
		"https://YouTube.com./watch?v=aircAruvnKk":    true,
		"https://www.youtube.com/@3blue1brown":        false,
		"https://www.youtube.com/":                    false,
		"https://notyoutube.com/watch?v=aircAruvnKk":  false,
		"https://example.com/youtube.com/watch":       false,
	} {
		rule, ok := c.RuleFor(url)
		if ok != want {
			t.Errorf("%s: matched = %v, want %v", url, ok, want)
		}
		if ok && (rule.ID != "youtube" || !rule.Builtin || !slices.Equal(rule.Providers, []string{"tavily"})) {
			t.Errorf("%s: rule = %+v", url, rule)
		}
	}
}

func TestADocumentChangesABuiltinRuleWithoutCopyingIt(t *testing.T) {
	c := Default()
	c.Routing.Builtin = map[string]BuiltinRule{
		"youtube": {Providers: []string{"tavily"}},
		"gone":    {Enabled: true},
	}
	c.Normalize()
	if c.Routing.Builtin != nil {
		t.Errorf("what repeats the rule or names none must be dropped: %+v", c.Routing.Builtin)
	}

	c.Routing.Builtin = map[string]BuiltinRule{"youtube": {Enabled: true, Providers: []string{"tavily", "brave", "firecrawl", "tavily"}}}
	c.Normalize()
	rule, _ := c.RuleFor("https://youtu.be/x")
	if !slices.Equal(rule.Providers, []string{"tavily", "firecrawl"}) {
		t.Errorf("providers = %v", rule.Providers)
	}

	// A list chosen for a rule is kept while the rule is off.
	c.Routing.Builtin = map[string]BuiltinRule{"youtube": {Providers: []string{"firecrawl"}}}
	c.Normalize()
	if _, ok := c.RuleFor("https://youtu.be/x"); ok || len(c.Routing.Builtin) != 1 {
		t.Errorf("a rule that is off must not match: %+v", c.Routing.Builtin)
	}
}

func TestOwnRulesComeFirstAndAreCleaned(t *testing.T) {
	c := Default()
	c.Routing.Rules = []Rule{{
		ID: "video", Name: " Video ", Enabled: true, Builtin: true,
		Match:     []string{"https://WWW.YouTube.com/watch?v=1", "*.example.com", "example.com", "docs.example.org:8443/Guide/"},
		Providers: []string{"firecrawl", "brave", "firecrawl", "exa"},
	}}
	c.Normalize()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	rule := c.Routing.Rules[0]
	if rule.Name != "Video" || rule.Builtin ||
		!slices.Equal(rule.Match, []string{"youtube.com/watch", "example.com", "docs.example.org/Guide/"}) ||
		!slices.Equal(rule.Providers, []string{"firecrawl", "exa"}) {
		t.Errorf("rule = %+v", rule)
	}
	if got, _ := c.RuleFor("https://www.youtube.com/watch?v=2"); got.ID != "video" {
		t.Errorf("the document's own rule must win over the built-in one: %+v", got)
	}
	c.Routing.Builtin = map[string]BuiltinRule{"youtube": {Enabled: true}}
	if got, _ := c.RuleFor("https://youtu.be/2"); got.ID != "youtube" {
		t.Errorf("rule = %+v", got)
	}
	if _, ok := c.RuleFor("https://docs.example.org/guide/"); ok {
		t.Error("a path prefix is matched as written")
	}

	for want, rule := range map[string]Rule{
		"used twice":           {ID: "youtube", Name: "x", Match: []string{"a.com"}, Providers: []string{"jina"}},
		"lowercase letters":    {ID: "Bad Id", Name: "x", Match: []string{"a.com"}, Providers: []string{"jina"}},
		"a name is required":   {ID: "a", Match: []string{"a.com"}, Providers: []string{"jina"}},
		"at least one domain":  {ID: "a", Name: "x", Providers: []string{"jina"}},
		"is not a domain":      {ID: "a", Name: "x", Match: []string{"localhost"}, Providers: []string{"jina"}},
		"at least one provide": {ID: "a", Name: "x", Match: []string{"a.com"}, Providers: []string{"brave"}},
	} {
		c := Default()
		c.Routing.Rules = []Rule{rule}
		c.Normalize()
		if err := c.Validate(); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: error = %v", want, err)
		}
	}
}
