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
	rules := c.RoutingRules()
	var ids []string
	for _, rule := range rules {
		ids = append(ids, rule.ID)
	}
	if want := []string{"youtube", "twitter", "linkedin", "reddit", "instagram", "threads", "facebook", "tiktok", "arxiv"}; !slices.Equal(ids, want) {
		t.Fatalf("rules = %v, want %v", ids, want)
	}
	for _, rule := range rules {
		if rule.Enabled {
			t.Fatalf("%s is on before anyone switched it on", rule.ID)
		}
	}
	if !slices.Equal(rules[1].Providers, []string{"tavily", "parallel"}) || !slices.Equal(rules[3].Providers, []string{"parallel"}) {
		t.Fatalf("providers = %v, %v", rules[1].Providers, rules[3].Providers)
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

func TestTwitterAndRedditAreRoutedOnceSwitchedOn(t *testing.T) {
	c := Default()
	c.Routing.Builtin = map[string]BuiltinRule{"twitter": {Enabled: true}, "reddit": {Enabled: true}}
	for url, want := range map[string]string{
		"https://x.com/jack/status/20":                   "twitter",
		"https://mobile.twitter.com/jack/status/20":      "twitter",
		"https://www.reddit.com/r/golang/comments/abc/x": "reddit",
		"https://old.reddit.com/r/golang/":               "reddit",
		"https://redd.it/abc":                            "reddit",
		"https://max.com/watch":                          "",
		"https://example.com/x.com":                      "",
		"https://notreddit.com/r/golang":                 "",
	} {
		rule, ok := c.RuleFor(url)
		if got := rule.ID; (ok && got != want) || (!ok && want != "") {
			t.Errorf("%s: rule = %q, want %q", url, got, want)
		}
	}
}

func TestSocialSitesAreRoutedOnceSwitchedOn(t *testing.T) {
	c := Default()
	c.Routing.Builtin = map[string]BuiltinRule{}
	for _, id := range []string{"instagram", "threads", "facebook", "tiktok", "linkedin"} {
		c.Routing.Builtin[id] = BuiltinRule{Enabled: true}
	}
	for url, want := range map[string]string{
		"https://www.instagram.com/nasa/p/abc":        "instagram",
		"https://instagr.am/p/abc":                    "instagram",
		"https://www.threads.com/@zuck/post/abc":      "threads",
		"https://www.threads.net/@zuck":               "threads",
		"https://web.facebook.com/NASA/posts/abc":     "facebook",
		"https://fb.watch/abc":                        "facebook",
		"https://vm.tiktok.com/abc":                   "tiktok",
		"https://www.tiktok.com/@nasa/video/1":        "tiktok",
		"https://www.linkedin.com/posts/someone_abc":  "linkedin",
		"https://lnkd.in/abc":                         "linkedin",
		"https://notlinkedin.com/in/someone":          "",
		"https://example.com/instagram.com/nasa":      "",
		"https://arxiv.org/abs/1706.03762":            "",
		"https://www.youtube.com/watch?v=aircAruvnKk": "",
	} {
		rule, ok := c.RuleFor(url)
		if got := rule.ID; (ok && got != want) || (!ok && want != "") {
			t.Errorf("%s: rule = %q, want %q", url, got, want)
		}
	}
	rule, _ := c.RuleFor("https://www.linkedin.com/in/someone")
	if !slices.Equal(rule.Providers, []string{"tavily", "parallel"}) {
		t.Errorf("linkedin providers = %v", rule.Providers)
	}
	rule, _ = c.RuleFor("https://www.tiktok.com/@nasa")
	if !slices.Equal(rule.Providers, []string{"parallel"}) {
		t.Errorf("tiktok providers = %v", rule.Providers)
	}
}

func TestArxivIsABuiltinRuleNoCapabilityStandsBehind(t *testing.T) {
	for _, info := range Catalog {
		for _, capability := range info.Capabilities {
			if capability.ID == "arxiv" {
				t.Fatalf("%s declares arxiv as a capability", info.ID)
			}
		}
	}
	c := Default()
	if _, ok := c.RuleFor("https://arxiv.org/abs/1706.03762"); ok {
		t.Fatal("a built-in rule must not match until it is switched on")
	}
	c.Routing.Builtin = map[string]BuiltinRule{"arxiv": {Enabled: true}}
	c.Normalize()
	rule, ok := c.RuleFor("https://arxiv.org/html/2501.12948v1")
	if !ok || !rule.Builtin || !slices.Equal(rule.Providers, []string{"exa", "firecrawl", "parallel"}) {
		t.Fatalf("rule = %+v, matched = %v", rule, ok)
	}

	// The order is the document's to change, and the catalog's list stays as it was.
	c.Routing.Builtin = map[string]BuiltinRule{"arxiv": {Enabled: true, Providers: []string{"parallel", "exa"}}}
	c.Normalize()
	rule, _ = c.RuleFor("https://export.arxiv.org/pdf/1706.03762")
	if !slices.Equal(rule.Providers, []string{"parallel", "exa"}) {
		t.Errorf("providers = %v", rule.Providers)
	}
	if !slices.Equal(siteRules[0].Providers, []string{"exa", "firecrawl", "parallel"}) {
		t.Errorf("the catalog's rule changed: %v", siteRules[0].Providers)
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

func TestReadsNamesOnlyWhatTheRulesInEffectDeliver(t *testing.T) {
	c := Default()
	c.Routing.Builtin = map[string]BuiltinRule{"youtube": {Enabled: true}, "twitter": {Enabled: true}, "arxiv": {Enabled: true}}
	c.Routing.Rules = []Rule{
		{ID: "wechat", Name: "WeChat", Enabled: true, Match: []string{"mp.weixin.qq.com"}, Providers: []string{"jina"}, Reads: "  WeChat   articles "},
		{ID: "docs", Name: "Docs", Enabled: true, Match: []string{"example.com"}, Providers: []string{"jina"}},
		{ID: "off", Name: "Off", Match: []string{"example.org"}, Providers: []string{"jina"}, Reads: "something"},
	}
	c.Normalize()
	// Jina needs no key; the providers behind the built-in rules have none yet.
	if got := c.Reads(); !slices.Equal(got, []string{"WeChat articles"}) {
		t.Fatalf("reads = %q", got)
	}
	c.Providers["tavily"].APIKey = "k"
	if got, want := c.Reads(), []string{"WeChat articles", capYouTube.Reads, capTwitter.Reads}; !slices.Equal(got, want) {
		t.Fatalf("reads = %q, want %q", got, want)
	}
	// A provider that returns a video's page without the transcript does not
	// make the rule deliver one.
	c.Providers["tavily"].APIKey = ""
	c.Routing.Builtin["youtube"] = BuiltinRule{Enabled: true, Providers: []string{"jina"}}
	if got := c.Reads(); !slices.Equal(got, []string{"WeChat articles"}) {
		t.Fatalf("reads = %q", got)
	}

	c.Routing.Rules[0].Reads = strings.Repeat("x", maxReads+1)
	if err := c.Validate(); err == nil {
		t.Fatal("an overlong phrase passed validation")
	}
}
