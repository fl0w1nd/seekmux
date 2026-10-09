// Package upstream knows how each search and fetch provider reports errors,
// where that differs from what the HTTP status alone says.
package upstream

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/fl0w1nd/seekmux/internal/core"
)

// Brave rejects a bad key with 422 instead of 401, and answers 429 both for
// its per-second limit and for a spent monthly quota. Its rate limit headers
// list one value per window, shortest first, with resets in seconds.
func Brave(e *core.HTTPError, header http.Header) {
	var body struct {
		Error struct {
			Code string `json:"code"`
			Meta struct {
				Errors []struct {
					Loc []any `json:"loc"`
				} `json:"errors"`
			} `json:"meta"`
		} `json:"error"`
	}
	_ = json.Unmarshal([]byte(e.Body), &body)

	switch body.Error.Code {
	case "SUBSCRIPTION_TOKEN_INVALID", "SUBSCRIPTION_NOT_FOUND":
		e.Class = core.ClassAuth
		return
	case "QUOTA_LIMITED":
		e.Class = core.ClassQuota
	case "VALIDATION":
		for _, item := range body.Error.Meta.Errors {
			for _, part := range item.Loc {
				if name, _ := part.(string); strings.EqualFold(name, "x-subscription-token") {
					e.Class = core.ClassAuth
					return
				}
			}
		}
	}
	if e.StatusCode != http.StatusTooManyRequests {
		return
	}

	remaining := windows(header.Get("X-RateLimit-Remaining"))
	reset := windows(header.Get("X-RateLimit-Reset"))
	if last := len(remaining) - 1; last >= 1 && remaining[last] == 0 {
		// The longest window is the plan's quota.
		e.Class = core.ClassQuota
		if last < len(reset) {
			e.DisableFor = time.Duration(reset[last]) * time.Second
		}
	}
	if e.Kind() == core.ClassRateLimit && !e.HasRetry && len(reset) > 0 && reset[0] > 0 {
		e.RetryAfter, e.HasRetry = time.Duration(reset[0])*time.Second, true
	}
}

// windows parses a header such as "1, 15000" into its numbers; anything
// malformed yields nothing.
func windows(value string) []int {
	if value == "" {
		return nil
	}
	var out []int
	for part := range strings.SplitSeq(value, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

// Exa names the cause in a tag. Some 403s are about the query rather than the
// account.
func Exa(e *core.HTTPError, _ http.Header) {
	var body struct {
		Tag string `json:"tag"`
	}
	_ = json.Unmarshal([]byte(e.Body), &body)
	switch body.Tag {
	case "PROHIBITED_CONTENT", "CONTENT_FILTER_ERROR":
		e.Class = core.ClassBadRequest
	case "NO_MORE_CREDITS", "API_KEY_BUDGET_EXCEEDED":
		e.Class = core.ClassQuota
	case "FEATURE_DISABLED", "TEAM_BLOCKED":
		e.Class = core.ClassAuth
	}
}

// Tavily has its own statuses for a spent plan (432) and a spent
// pay-as-you-go limit (433).
func Tavily(e *core.HTTPError, _ http.Header) {
	if e.StatusCode == 432 || e.StatusCode == 433 {
		e.Class = core.ClassQuota
	}
}

// Jina answers 403 and 422 when the site, not the request, is the problem:
// it blocked the reader, or the page would not load.
func Jina(e *core.HTTPError, _ http.Header) {
	var body struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal([]byte(e.Body), &body)
	switch {
	case body.Name == "ParamValidationError":
		e.Class = core.ClassBadRequest
	case body.Name == "AbuseAlleviationError", body.Name == "SecurityCompromiseError",
		e.StatusCode == http.StatusUnprocessableEntity:
		e.Class = core.ClassTarget
	}
}

// firecrawlRequestCodes are scrape failures caused by the options sent.
var firecrawlRequestCodes = map[string]bool{
	"SCRAPE_ACTION_ERROR":        true,
	"SCRAPE_ZDR_VIOLATION_ERROR": true,
}

// Firecrawl reports a page it could not scrape as 408 or 500 with a SCRAPE_*
// code, which says nothing about Firecrawl's own health.
func Firecrawl(e *core.HTTPError, _ http.Header) {
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal([]byte(e.Body), &body)
	switch {
	case firecrawlRequestCodes[body.Code]:
		e.Class = core.ClassBadRequest
	case strings.HasPrefix(body.Code, "SCRAPE_"), body.Code == "UNSUPPORTED_SITE":
		e.Class = core.ClassTarget
	}
}
