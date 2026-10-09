// Package fetch implements the page fetch tool: it loads a page through the
// configured fetch providers and answers a prompt against it with the extract
// model, or returns the original text.
package fetch

import (
	"context"
	"fmt"
	"net/http"
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

type executor func(ctx context.Context, client *http.Client, base, apiKey string, in Input) (Page, error)

var executors = map[string]executor{
	"jina":      jinaFetch,
	"firecrawl": firecrawlFetch,
	"tavily":    tavilyFetch,
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
		out = append(out, core.Provider[Input, Page]{
			Name:        route.Provider,
			Key:         route.Provider + ":" + config.ToolFetch,
			RateLimit:   limit,
			Concurrency: route.Concurrency,
			Available:   route.Enabled && (creds.APIKey != "" || !info.KeyRequired),
			Execute: func(ctx context.Context, in Input) (Page, error) {
				page, err := run(ctx, client, base, creds.APIKey, in)
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

func jinaFetch(ctx context.Context, client *http.Client, base, apiKey string, in Input) (Page, error) {
	header := map[string]string{}
	if apiKey != "" {
		header["Authorization"] = "Bearer " + apiKey
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
	err := core.DoJSON(ctx, client, core.Request{Provider: "Jina", Classify: upstream.Jina, URL: base + "/" + in.URL, Header: header}, &raw)
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

func firecrawlFetch(ctx context.Context, client *http.Client, base, apiKey string, in Input) (Page, error) {
	body := map[string]any{"url": in.URL, "formats": []string{"markdown"}}
	if in.IsPDF {
		body["parsers"] = []string{"pdf"}
	}
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
	err := core.DoJSON(ctx, client, core.Request{
		Provider: "Firecrawl",
		Classify: upstream.Firecrawl,
		Method:   http.MethodPost,
		URL:      base + "/v2/scrape",
		Header:   map[string]string{"Authorization": "Bearer " + apiKey},
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

func tavilyFetch(ctx context.Context, client *http.Client, base, apiKey string, in Input) (Page, error) {
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
	err := core.DoJSON(ctx, client, core.Request{
		Provider: "Tavily",
		Classify: upstream.Tavily,
		Method:   http.MethodPost,
		URL:      base + "/extract",
		Header:   map[string]string{"Authorization": "Bearer " + apiKey},
		Body:     map[string]any{"urls": []string{in.URL}},
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

func siteError(provider string, status int) error {
	return &core.TargetError{Provider: provider, Reason: fmt.Sprintf("the site answered %d %s", status, http.StatusText(status))}
}
