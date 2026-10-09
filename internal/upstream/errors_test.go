package upstream

import (
	"net/http"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/core"
)

func TestClassification(t *testing.T) {
	header := func(pairs ...string) http.Header {
		h := http.Header{}
		for i := 0; i < len(pairs); i += 2 {
			h.Set(pairs[i], pairs[i+1])
		}
		return h
	}
	cases := []struct {
		name     string
		classify func(*core.HTTPError, http.Header)
		status   int
		body     string
		header   http.Header
		want     core.Class
	}{
		{"brave invalid key", Brave, 422, `{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID"}}`, nil, core.ClassAuth},
		{"brave missing key", Brave, 422, `{"error":{"code":"VALIDATION","meta":{"errors":[{"loc":["header","x-subscription-token"]}]}}}`, nil, core.ClassAuth},
		{"brave bad parameter", Brave, 422, `{"error":{"code":"VALIDATION","meta":{"errors":[{"loc":["query","count"]}]}}}`, nil, core.ClassBadRequest},
		{"brave per second", Brave, 429, `{"error":{"code":"RATE_LIMITED"}}`, header("X-RateLimit-Remaining", "0, 1200", "X-RateLimit-Reset", "1, 86400"), core.ClassRateLimit},
		{"brave monthly by header", Brave, 429, `{}`, header("X-RateLimit-Remaining", "1, 0", "X-RateLimit-Reset", "1, 86400"), core.ClassQuota},
		{"brave monthly by code", Brave, 429, `{"error":{"code":"QUOTA_LIMITED"}}`, nil, core.ClassQuota},
		{"exa content filter", Exa, 403, `{"tag":"PROHIBITED_CONTENT"}`, nil, core.ClassBadRequest},
		{"exa blocked team", Exa, 403, `{"tag":"TEAM_BLOCKED"}`, nil, core.ClassAuth},
		{"exa credits", Exa, 402, `{"tag":"NO_MORE_CREDITS"}`, nil, core.ClassQuota},
		{"tavily plan", Tavily, 432, `{}`, nil, core.ClassQuota},
		{"tavily paygo", Tavily, 433, `{}`, nil, core.ClassQuota},
		{"exa unexplained 403", Exa, 403, `<html>blocked</html>`, nil, core.ClassProvider},
		{"exa rate limit", Exa, 429, `{"tag":"RATE_LIMITED"}`, nil, core.ClassRateLimit},
		{"tavily rate limit", Tavily, 429, `{}`, nil, core.ClassRateLimit},
		{"jina rate limit", Jina, 429, `{"name":"RateLimitTriggeredError"}`, nil, core.ClassRateLimit},
		{"firecrawl rate limit", Firecrawl, 429, `{"success":false}`, nil, core.ClassRateLimit},
		{"tavily key", Tavily, 401, `{}`, nil, core.ClassAuth},
		{"jina blocked site", Jina, 403, `{"name":"SecurityCompromiseError"}`, nil, core.ClassTarget},
		{"jina page failed", Jina, 422, `{"name":"AssertionFailureError"}`, nil, core.ClassTarget},
		{"jina bad parameter", Jina, 422, `{"name":"ParamValidationError"}`, nil, core.ClassBadRequest},
		{"jina key", Jina, 401, `{"name":"AuthenticationRequiredError"}`, nil, core.ClassAuth},
		{"firecrawl timeout", Firecrawl, 408, `{"success":false,"code":"SCRAPE_TIMEOUT"}`, nil, core.ClassTarget},
		{"firecrawl engines", Firecrawl, 500, `{"success":false,"code":"SCRAPE_ALL_ENGINES_FAILED"}`, nil, core.ClassTarget},
		{"firecrawl action", Firecrawl, 500, `{"success":false,"code":"SCRAPE_ACTION_ERROR"}`, nil, core.ClassBadRequest},
		{"firecrawl own failure", Firecrawl, 500, `not json`, nil, core.ClassProvider},
		{"firecrawl credits", Firecrawl, 402, `{"success":false}`, nil, core.ClassQuota},
	}
	for _, c := range cases {
		e := &core.HTTPError{StatusCode: c.status, Body: c.body}
		c.classify(e, c.header)
		if got := e.Kind(); got != c.want {
			t.Errorf("%s: class = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestBraveReadsItsWindows(t *testing.T) {
	h := http.Header{}
	h.Set("X-RateLimit-Remaining", "0, 900")
	h.Set("X-RateLimit-Reset", "1, 86400")
	e := &core.HTTPError{StatusCode: 429}
	Brave(e, h)
	if !e.HasRetry || e.RetryAfter != time.Second {
		t.Fatalf("the short window gives the retry delay: %v %v", e.HasRetry, e.RetryAfter)
	}

	h.Set("X-RateLimit-Remaining", "1, 0")
	e = &core.HTTPError{StatusCode: 429}
	Brave(e, h)
	if e.DisableFor != 24*time.Hour {
		t.Fatalf("the long window says when the quota is back: %v", e.DisableFor)
	}
}
