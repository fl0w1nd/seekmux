// Package fetch implements the page fetch tool: it loads a page through the
// configured fetch providers and answers a prompt against it with the extract
// model, or returns the original text.
package fetch

import (
	"context"
	"fmt"
	"maps"
	"net/http"
	"strconv"
	"strings"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/upstream"
)

type Input struct {
	URL   string
	IsPDF bool
}

// Page is a fetched page. Engine names the provider that produced it.
type Page struct {
	URL         string
	Title       string
	Description string
	Content     string
	Engine      string
}

// call is what a provider needs besides the URL: where and how to reach it,
// and the route's settings.
type call struct {
	client *http.Client
	base   string
	apiKey string
	opt    config.Values
	// extra is merged into the request last.
	extra map[string]any
}

type executor func(ctx context.Context, c call, in Input) (Page, error)

var executors = map[string]executor{
	"jina":      jinaFetch,
	"firecrawl": firecrawlFetch,
	"tavily":    tavilyFetch,
	"exa":       exaFetch,
}

// Providers builds the fetch providers of cfg in priority order.
func Providers(cfg *config.Config, client *http.Client) []core.Provider[Input, Page] {
	var out []core.Provider[Input, Page]
	for _, route := range cfg.Fetch.Routes {
		run, ok := executors[route.Provider]
		if !ok {
			continue
		}
		info, _ := config.Info(route.Provider)
		creds := cfg.Providers[route.Provider]
		base := creds.BaseURL
		if base == "" {
			base = info.DefaultBase[config.ToolFetch]
		}
		limit, _ := config.ParseRateLimit(route.RateLimit)
		c := call{client: client, base: base, apiKey: creds.APIKey, opt: config.OptionValues(config.ToolFetch, route), extra: route.ExtraBody}
		out = append(out, core.Provider[Input, Page]{
			Name:        route.Provider,
			Key:         route.Provider + ":" + config.ToolFetch,
			RateLimit:   limit,
			Concurrency: route.Concurrency,
			Available:   route.Enabled && (creds.APIKey != "" || !info.KeyRequired),
			Execute: func(ctx context.Context, in Input) (Page, error) {
				page, err := run(ctx, c, in)
				if err == nil && strings.TrimSpace(page.Content) == "" {
					// An empty page is a failed fetch: let the next provider try.
					return Page{}, &core.TargetError{Provider: info.Name, Reason: "the page came back empty"}
				}
				return page, err
			},
		})
	}
	return out
}

// Jina takes its parameters as headers.
func jinaFetch(ctx context.Context, c call, in Input) (Page, error) {
	header := map[string]string{}
	if c.apiKey != "" {
		header["Authorization"] = "Bearer " + c.apiKey
	}
	if v := c.opt.Str("engine"); v != "auto" {
		header["X-Engine"] = v
	}
	if v := c.opt.Str("retain_images"); v != "all" {
		header["X-Retain-Images"] = v
	}
	if seconds, ok := c.opt.Int("cache_tolerance_seconds"); ok {
		header["X-Cache-Tolerance"] = strconv.Itoa(seconds)
	}
	if v := c.opt.Str("proxy_country"); v != "" {
		header["X-Proxy"] = strings.ToLower(v)
	}
	for key, value := range c.extra {
		header[key] = fmt.Sprint(value)
	}
	var raw struct {
		Data struct {
			Title       string `json:"title"`
			Description string `json:"description"`
			URL         string `json:"url"`
			Content     string `json:"content"`
			HTTPStatus  int    `json:"httpStatus"`
		} `json:"data"`
	}
	err := core.DoJSON(ctx, c.client, core.Request{Provider: "Jina", Classify: upstream.Jina, URL: c.base + "/" + in.URL, Header: header}, &raw)
	if err != nil {
		return Page{}, err
	}
	d := raw.Data
	if d.HTTPStatus >= 400 {
		// Jina succeeded in reading the site's error page.
		return Page{}, siteError("Jina", d.HTTPStatus)
	}
	return Page{URL: d.URL, Title: d.Title, Description: d.Description, Content: d.Content}, nil
}

func firecrawlFetch(ctx context.Context, c call, in Input) (Page, error) {
	body := map[string]any{"url": in.URL, "formats": []string{"markdown"}}
	if hours, _ := c.opt.Int("max_age_hours"); hours != 48 {
		body["maxAge"] = hours * 3600 * 1000
	}
	if v := c.opt.Str("proxy"); v != "auto" {
		body["proxy"] = v
	}
	if ms, _ := c.opt.Int("wait_for_ms"); ms > 0 {
		body["waitFor"] = ms
	}
	if !c.opt.Bool("only_main_content") {
		body["onlyMainContent"] = false
	}
	if v := c.opt.Str(config.OptionCountry); v != "" {
		body["location"] = map[string]any{"country": v}
	}
	// A PDF is billed by the page, and not every PDF has the extension, so a
	// page limit goes out with every request.
	parser := map[string]any{"type": "pdf"}
	if v := c.opt.Str("pdf_mode"); v != "auto" {
		parser["mode"] = v
	}
	if pages, ok := c.opt.Int("pdf_max_pages"); ok {
		parser["maxPages"] = pages
	}
	if len(parser) > 1 {
		body["parsers"] = []any{parser}
	} else if in.IsPDF {
		body["parsers"] = []string{"pdf"}
	}
	maps.Copy(body, c.extra)
	var raw struct {
		Data struct {
			Markdown string `json:"markdown"`
			Metadata struct {
				Title       string `json:"title"`
				Description string `json:"description"`
				SourceURL   string `json:"sourceURL"`
				StatusCode  int    `json:"statusCode"`
			} `json:"metadata"`
		} `json:"data"`
	}
	err := core.DoJSON(ctx, c.client, core.Request{
		Provider: "Firecrawl",
		Classify: upstream.Firecrawl,
		Method:   http.MethodPost,
		URL:      c.base + "/v2/scrape",
		Header:   map[string]string{"Authorization": "Bearer " + c.apiKey},
		Body:     body,
	}, &raw)
	if err != nil {
		return Page{}, err
	}
	m := raw.Data.Metadata
	if m.StatusCode >= 400 {
		return Page{}, siteError("Firecrawl", m.StatusCode)
	}
	return Page{URL: m.SourceURL, Title: m.Title, Description: m.Description, Content: raw.Data.Markdown}, nil
}

func tavilyFetch(ctx context.Context, c call, in Input) (Page, error) {
	body := map[string]any{"urls": []string{in.URL}}
	if v := c.opt.Str("extract_depth"); v != "basic" {
		body["extract_depth"] = v
	}
	maps.Copy(body, c.extra)

	var raw struct {
		Results []struct {
			Title      string `json:"title"`
			URL        string `json:"url"`
			RawContent string `json:"raw_content"`
		} `json:"results"`
		FailedResults []struct {
			Error string `json:"error"`
		} `json:"failed_results"`
	}
	err := core.DoJSON(ctx, c.client, core.Request{
		Provider: "Tavily",
		Classify: upstream.Tavily,
		Method:   http.MethodPost,
		URL:      c.base + "/extract",
		Header:   map[string]string{"Authorization": "Bearer " + c.apiKey},
		Body:     body,
	}, &raw)
	if err != nil {
		return Page{}, err
	}
	if len(raw.Results) == 0 {
		reason := "no content returned"
		if len(raw.FailedResults) > 0 && raw.FailedResults[0].Error != "" {
			reason = raw.FailedResults[0].Error
		}
		return Page{}, &core.TargetError{Provider: "Tavily", Reason: reason}
	}
	r := raw.Results[0]
	return Page{URL: r.URL, Title: r.Title, Content: r.RawContent}, nil
}

// exaFetch reads a page through Exa's contents endpoint, which answers from
// its index and crawls the page when it has no copy that is recent enough.
func exaFetch(ctx context.Context, c call, in Input) (Page, error) {
	timeout, _ := c.opt.Int("livecrawl_timeout_ms")
	body := map[string]any{
		"urls":             []string{in.URL},
		"text":             map[string]any{"verbosity": c.opt.Str("verbosity")},
		"livecrawlTimeout": timeout,
	}
	if hours, ok := c.opt.Int("max_age_hours"); ok {
		body["maxAgeHours"] = hours
	}
	maps.Copy(body, c.extra)

	var raw struct {
		Results []struct {
			Title string `json:"title"`
			URL   string `json:"url"`
			Text  string `json:"text"`
		} `json:"results"`
		Statuses []struct {
			Status string `json:"status"`
			Error  struct {
				Tag        string `json:"tag"`
				HTTPStatus int    `json:"httpStatusCode"`
			} `json:"error"`
		} `json:"statuses"`
	}
	err := core.DoJSON(ctx, c.client, core.Request{
		Provider: "Exa",
		Classify: upstream.Exa,
		Method:   http.MethodPost,
		URL:      c.base + "/contents",
		Header:   map[string]string{"x-api-key": c.apiKey},
		Body:     body,
	}, &raw)
	if err != nil {
		return Page{}, err
	}
	if len(raw.Results) == 0 {
		reason := "no content returned"
		if len(raw.Statuses) > 0 && raw.Statuses[0].Status == "error" {
			e := raw.Statuses[0].Error
			if e.HTTPStatus >= 400 {
				return Page{}, siteError("Exa", e.HTTPStatus)
			}
			if e.Tag != "" {
				reason = e.Tag
			}
		}
		return Page{}, &core.TargetError{Provider: "Exa", Reason: reason}
	}
	r := raw.Results[0]
	return Page{URL: r.URL, Title: r.Title, Content: r.Text}, nil
}

func siteError(provider string, status int) error {
	return &core.TargetError{Provider: provider, Reason: fmt.Sprintf("the site answered %d %s", status, http.StatusText(status))}
}
