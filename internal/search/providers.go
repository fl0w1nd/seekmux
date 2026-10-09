// Package search implements the web search tool on top of the configured
// search providers.
package search

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/upstream"
)

// TimeRanges are the accepted values of the time_range argument.
var TimeRanges = []string{"day", "week", "month", "year"}

type Input struct {
	Query      string
	MaxResults int
	TimeRange  string
}

type Item struct {
	Title       string   `json:"title,omitempty"`
	URL         string   `json:"url,omitempty"`
	Description string   `json:"description,omitempty"`
	Age         string   `json:"age,omitempty"`
	Duration    string   `json:"duration,omitempty"`
	Score       *float64 `json:"score,omitempty"`
}

type Output struct {
	Query  string
	Web    []Item
	Videos []Item
}

type executor func(ctx context.Context, client *http.Client, base, apiKey string, in Input) (Output, error)

var executors = map[string]executor{
	"brave":  braveSearch,
	"exa":    exaSearch,
	"tavily": tavilySearch,
}

// Providers builds the search providers of cfg in priority order.
func Providers(cfg *config.Config, client *http.Client) []core.Provider[Input, Output] {
	var out []core.Provider[Input, Output]
	for _, route := range cfg.Search.Routes {
		run, ok := executors[route.Provider]
		if !ok {
			continue
		}
		info, _ := config.Info(route.Provider)
		creds := cfg.Providers[route.Provider]
		base := creds.BaseURL
		if base == "" {
			base = info.DefaultBase[config.ToolSearch]
		}
		limit, _ := config.ParseRateLimit(route.RateLimit)
		out = append(out, core.Provider[Input, Output]{
			Name:        route.Provider,
			Key:         route.Provider + ":" + config.ToolSearch,
			RateLimit:   limit,
			Concurrency: route.Concurrency,
			Available:   route.Enabled && (creds.APIKey != "" || !info.KeyRequired),
			Execute: func(ctx context.Context, in Input) (Output, error) {
				return run(ctx, client, base, creds.APIKey, in)
			},
		})
	}
	return out
}

var braveFreshness = map[string]string{"day": "pd", "week": "pw", "month": "pm", "year": "py"}

func braveSearch(ctx context.Context, client *http.Client, base, apiKey string, in Input) (Output, error) {
	query := url.Values{}
	query.Set("q", in.Query)
	query.Set("count", strconv.Itoa(min(in.MaxResults, 20)))
	if f := braveFreshness[in.TimeRange]; f != "" {
		query.Set("freshness", f)
	}

	type result struct {
		Title       string `json:"title"`
		URL         string `json:"url"`
		Description string `json:"description"`
		Age         string `json:"age"`
		Video       struct {
			Duration string `json:"duration"`
		} `json:"video"`
	}
	var raw struct {
		Query struct {
			Original string `json:"original"`
		} `json:"query"`
		Web struct {
			Results []result `json:"results"`
		} `json:"web"`
		Videos struct {
			Results []result `json:"results"`
		} `json:"videos"`
	}
	err := core.DoJSON(ctx, client, core.Request{
		Provider: "Brave",
		Classify: upstream.Brave,
		URL:      base + "/res/v1/web/search",
		Query:    query,
		Header:   map[string]string{"X-Subscription-Token": apiKey},
	}, &raw)
	if err != nil {
		return Output{}, err
	}

	out := Output{Query: raw.Query.Original, Web: []Item{}}
	for _, r := range raw.Web.Results {
		out.Web = append(out.Web, Item{Title: r.Title, URL: r.URL, Description: r.Description, Age: r.Age})
	}
	for _, r := range raw.Videos.Results {
		out.Videos = append(out.Videos, Item{Title: r.Title, URL: r.URL, Description: r.Description, Age: r.Age, Duration: r.Video.Duration})
	}
	return out, nil
}

func exaStartDate(timeRange string, now time.Time) string {
	now = now.UTC()
	switch timeRange {
	case "day":
		now = now.AddDate(0, 0, -1)
	case "week":
		now = now.AddDate(0, 0, -7)
	case "month":
		now = now.AddDate(0, -1, 0)
	case "year":
		now = now.AddDate(-1, 0, 0)
	default:
		return ""
	}
	return now.Format("2006-01-02T15:04:05.000Z")
}

func exaSearch(ctx context.Context, client *http.Client, base, apiKey string, in Input) (Output, error) {
	body := map[string]any{
		"query":      in.Query,
		"numResults": min(in.MaxResults, 100),
		"type":       "auto",
	}
	if start := exaStartDate(in.TimeRange, time.Now()); start != "" {
		body["startPublishedDate"] = start
	}

	var raw struct {
		Results []struct {
			Title         string   `json:"title"`
			URL           string   `json:"url"`
			Text          string   `json:"text"`
			Summary       string   `json:"summary"`
			Highlights    []string `json:"highlights"`
			PublishedDate string   `json:"publishedDate"`
		} `json:"results"`
	}
	err := core.DoJSON(ctx, client, core.Request{
		Provider: "Exa",
		Classify: upstream.Exa,
		Method:   http.MethodPost,
		URL:      base + "/search",
		Header:   map[string]string{"x-api-key": apiKey},
		Body:     body,
	}, &raw)
	if err != nil {
		return Output{}, err
	}

	out := Output{Query: in.Query, Web: []Item{}}
	for _, r := range raw.Results {
		description := r.Text
		if description == "" {
			description = r.Summary
		}
		if description == "" {
			description = strings.Join(r.Highlights, " … ")
		}
		out.Web = append(out.Web, Item{Title: r.Title, URL: r.URL, Description: description, Age: r.PublishedDate})
	}
	return out, nil
}

func tavilySearch(ctx context.Context, client *http.Client, base, apiKey string, in Input) (Output, error) {
	body := map[string]any{
		"query":        in.Query,
		"search_depth": "advanced",
		"max_results":  min(in.MaxResults, 20),
	}
	if in.TimeRange != "" {
		body["time_range"] = in.TimeRange
	}

	var raw struct {
		Query   string `json:"query"`
		Results []struct {
			Title   string   `json:"title"`
			URL     string   `json:"url"`
			Content string   `json:"content"`
			Score   *float64 `json:"score"`
		} `json:"results"`
	}
	err := core.DoJSON(ctx, client, core.Request{
		Provider: "Tavily",
		Classify: upstream.Tavily,
		Method:   http.MethodPost,
		URL:      base + "/search",
		Header:   map[string]string{"Authorization": "Bearer " + apiKey},
		Body:     body,
	}, &raw)
	if err != nil {
		return Output{}, err
	}

	out := Output{Query: raw.Query, Web: []Item{}}
	for _, r := range raw.Results {
		out.Web = append(out.Web, Item{Title: r.Title, URL: r.URL, Description: r.Content, Score: r.Score})
	}
	return out, nil
}
