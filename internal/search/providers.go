// Package search implements the web search tool on top of the configured
// search providers.
package search

import (
	"cmp"
	"context"
	"fmt"
	"html"
	"maps"
	"net/http"
	"net/url"
	"regexp"
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
	// IncludeDomains and ExcludeDomains are bare host names.
	IncludeDomains []string
	ExcludeDomains []string
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

// call is what a provider needs besides the query: where and how to reach
// it, and the route's settings.
type call struct {
	client *http.Client
	base   string
	apiKey string
	opt    config.Values
	// extra is merged into the request last.
	extra map[string]any
	// country and language are the route's or else the global ones; empty
	// when unset or when the provider has no such parameter.
	country, language string
}

type executor func(ctx context.Context, c call, in Input) (Output, error)

var executors = map[string]executor{
	"brave":      braveSearch,
	"exa":        exaSearch,
	"perplexity": perplexitySearch,
	"tavily":     tavilySearch,
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
		c := call{client: client, base: base, apiKey: creds.APIKey, opt: config.OptionValues(config.ToolSearch, route), extra: route.ExtraBody}
		if _, ok := c.opt[config.OptionCountry]; ok {
			c.country = cmp.Or(c.opt.Str(config.OptionCountry), cfg.Search.Country)
		}
		if _, ok := c.opt[config.OptionLanguage]; ok {
			c.language = cmp.Or(c.opt.Str(config.OptionLanguage), cfg.Search.Language)
		}
		out = append(out, core.Provider[Input, Output]{
			Name:        route.Provider,
			Key:         route.Provider + ":" + config.ToolSearch,
			RateLimit:   limit,
			Concurrency: route.Concurrency,
			Available:   route.Enabled && (creds.APIKey != "" || !info.KeyRequired),
			Execute: func(ctx context.Context, in Input) (Output, error) {
				return run(ctx, c, in)
			},
		})
	}
	return out
}

var braveFreshness = map[string]string{"day": "pd", "week": "pw", "month": "pm", "year": "py"}

// braveLanguages are the languages Brave names differently from ISO 639-1.
var braveLanguages = map[string]string{"zh": "zh-hans", "ja": "jp", "pt": "pt-br", "no": "nb"}

// braveQuery adds the domain filters as search operators, the only form
// Brave takes them in.
func braveQuery(in Input) string {
	var b strings.Builder
	b.WriteString(in.Query)
	switch len(in.IncludeDomains) {
	case 0:
	case 1:
		b.WriteString(" site:" + in.IncludeDomains[0])
	default:
		b.WriteString(" (site:" + strings.Join(in.IncludeDomains, " OR site:") + ")")
	}
	for _, d := range in.ExcludeDomains {
		b.WriteString(" -site:" + d)
	}
	return b.String()
}

func braveSearch(ctx context.Context, c call, in Input) (Output, error) {
	query := url.Values{}
	query.Set("q", braveQuery(in))
	query.Set("count", strconv.Itoa(min(in.MaxResults, 20)))
	if f := braveFreshness[in.TimeRange]; f != "" {
		query.Set("freshness", f)
	}
	if c.country != "" {
		query.Set("country", c.country)
	}
	if c.language != "" {
		query.Set("search_lang", cmp.Or(braveLanguages[c.language], c.language))
	}
	if c.opt.Bool("extra_snippets") {
		query.Set("extra_snippets", "true")
	}
	if v := c.opt.Str("safesearch"); v != "moderate" {
		query.Set("safesearch", v)
	}
	if v := c.opt.Str("goggles"); v != "" {
		query.Set("goggles", v)
	}
	for key, value := range c.extra {
		query.Set(key, fmt.Sprint(value))
	}

	type result struct {
		Title       string   `json:"title"`
		URL         string   `json:"url"`
		Description string   `json:"description"`
		Extra       []string `json:"extra_snippets"`
		Age         string   `json:"age"`
		Video       struct {
			Duration string `json:"duration"`
		} `json:"video"`
	}
	var raw struct {
		Web struct {
			Results []result `json:"results"`
		} `json:"web"`
		Videos struct {
			Results []result `json:"results"`
		} `json:"videos"`
	}
	err := core.DoJSON(ctx, c.client, core.Request{
		Provider: "Brave",
		Classify: upstream.Brave,
		URL:      c.base + "/res/v1/web/search",
		Query:    query,
		Header:   map[string]string{"X-Subscription-Token": c.apiKey},
	}, &raw)
	if err != nil {
		return Output{}, err
	}

	// Brave echoes the query with the operators added above.
	out := Output{Query: in.Query, Web: []Item{}}
	for _, r := range raw.Web.Results {
		parts := []string{braveText(r.Description)}
		for _, extra := range r.Extra {
			parts = append(parts, braveText(extra))
		}
		out.Web = append(out.Web, Item{Title: braveText(r.Title), URL: r.URL, Description: strings.Join(parts, "\n"), Age: r.Age})
	}
	for _, r := range raw.Videos.Results {
		out.Videos = append(out.Videos, Item{Title: braveText(r.Title), URL: r.URL, Description: braveText(r.Description), Age: r.Age, Duration: r.Video.Duration})
	}
	return out, nil
}

var htmlTag = regexp.MustCompile(`<[^>]*>`)

// braveText turns Brave's display markup (<strong> around the matched terms,
// entities such as &#x27;) into plain text. Brave escapes a literal "<" in
// the text, so every "<" left is the start of a tag.
func braveText(s string) string {
	return html.UnescapeString(htmlTag.ReplaceAllString(s, ""))
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

func exaSearch(ctx context.Context, c call, in Input) (Output, error) {
	// Without contents a result is a bare title and URL. Highlights come at
	// the price of the search itself; unbounded they run to several thousand
	// characters a result.
	contents := map[string]any{}
	limit, _ := c.opt.Int("max_characters")
	switch mode := c.opt.Str("contents"); mode {
	case "summary":
		contents[mode] = map[string]any{}
	default:
		contents[mode] = map[string]any{"maxCharacters": limit}
	}
	if hours, ok := c.opt.Int("max_age_hours"); ok {
		contents["maxAgeHours"] = hours
	}
	body := map[string]any{
		"query":      in.Query,
		"numResults": min(in.MaxResults, 100),
		"type":       c.opt.Str("type"),
		"contents":   contents,
	}
	if start := exaStartDate(in.TimeRange, time.Now()); start != "" {
		body["startPublishedDate"] = start
	}
	if c.country != "" {
		body["userLocation"] = c.country
	}
	if len(in.IncludeDomains) > 0 {
		body["includeDomains"] = in.IncludeDomains
	}
	if len(in.ExcludeDomains) > 0 {
		body["excludeDomains"] = in.ExcludeDomains
	}
	maps.Copy(body, c.extra)

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
	err := core.DoJSON(ctx, c.client, core.Request{
		Provider: "Exa",
		Classify: upstream.Exa,
		Method:   http.MethodPost,
		URL:      c.base + "/search",
		Header:   map[string]string{"x-api-key": c.apiKey},
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

func perplexitySearch(ctx context.Context, c call, in Input) (Output, error) {
	// Unbounded, a snippet is whatever the page has on the query and can run
	// to several thousand characters; the default of 256 tokens keeps it
	// near one thousand.
	perPage, _ := c.opt.Int("max_tokens_per_page")
	body := map[string]any{
		"query":               in.Query,
		"max_results":         min(in.MaxResults, 20),
		"max_tokens_per_page": perPage,
	}
	if v := c.opt.Str("search_type"); v != "web" {
		body["search_type"] = v
	}
	if total, ok := c.opt.Int("max_tokens"); ok {
		body["max_tokens"] = total
	}
	if in.TimeRange != "" {
		body["search_recency_filter"] = in.TimeRange
	}
	if c.country != "" {
		body["country"] = c.country
	}
	if c.language != "" {
		body["search_language_filter"] = []string{c.language}
	}
	// The filter is either an allowlist or a denylist. Given both, the
	// allowlist goes to the API and Run drops the excluded hosts.
	if len(in.IncludeDomains) > 0 {
		body["search_domain_filter"] = in.IncludeDomains
	} else if len(in.ExcludeDomains) > 0 {
		deny := make([]string, len(in.ExcludeDomains))
		for i, d := range in.ExcludeDomains {
			deny[i] = "-" + d
		}
		body["search_domain_filter"] = deny
	}
	maps.Copy(body, c.extra)

	var raw struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Snippet string `json:"snippet"`
			// last_updated is also returned, but it follows the crawl rather
			// than the page and would pass an old page off as a recent one.
			Date string `json:"date"`
		} `json:"results"`
	}
	err := core.DoJSON(ctx, c.client, core.Request{
		Provider: "Perplexity",
		Method:   http.MethodPost,
		URL:      c.base + "/search",
		Header:   map[string]string{"Authorization": "Bearer " + c.apiKey},
		Body:     body,
	}, &raw)
	if err != nil {
		return Output{}, err
	}

	out := Output{Query: in.Query, Web: []Item{}}
	for _, r := range raw.Results {
		out.Web = append(out.Web, Item{Title: r.Title, URL: r.URL, Description: r.Snippet, Age: r.Date})
	}
	return out, nil
}

func tavilySearch(ctx context.Context, c call, in Input) (Output, error) {
	topic := c.opt.Str("topic")
	body := map[string]any{
		"query":                  in.Query,
		"search_depth":           c.opt.Str("search_depth"),
		"max_results":            min(in.MaxResults, 20),
		"include_published_date": true,
	}
	if chunks, _ := c.opt.Int("chunks_per_source"); chunks != 3 {
		body["chunks_per_source"] = chunks
	}
	if topic != "general" {
		body["topic"] = topic
	}
	if in.TimeRange != "" {
		body["time_range"] = in.TimeRange
	}
	// Tavily names countries in full and takes one for general searches only.
	if name := tavilyCountries[c.country]; name != "" && topic == "general" {
		body["country"] = name
	}
	if c.language != "" {
		body["language"] = c.language
	}
	if len(in.IncludeDomains) > 0 {
		body["include_domains"] = in.IncludeDomains
	}
	if len(in.ExcludeDomains) > 0 {
		body["exclude_domains"] = in.ExcludeDomains
	}
	maps.Copy(body, c.extra)

	var raw struct {
		Query   string `json:"query"`
		Results []struct {
			Title   string   `json:"title"`
			URL     string   `json:"url"`
			Content string   `json:"content"`
			Score   *float64 `json:"score"`
			Date    string   `json:"published_date"`
		} `json:"results"`
	}
	err := core.DoJSON(ctx, c.client, core.Request{
		Provider: "Tavily",
		Classify: upstream.Tavily,
		Method:   http.MethodPost,
		URL:      c.base + "/search",
		Header:   map[string]string{"Authorization": "Bearer " + c.apiKey},
		Body:     body,
	}, &raw)
	if err != nil {
		return Output{}, err
	}

	out := Output{Query: raw.Query, Web: []Item{}}
	for _, r := range raw.Results {
		age := r.Date
		if t, err := time.Parse(time.RFC1123, age); err == nil {
			age = t.Format(time.DateOnly)
		}
		out.Web = append(out.Web, Item{Title: r.Title, URL: r.URL, Description: r.Content, Age: age, Score: r.Score})
	}
	return out, nil
}

// tavilyCountries maps ISO 3166-1 alpha-2 codes to the names Tavily accepts.
var tavilyCountries = map[string]string{
	"AF": "afghanistan", "AL": "albania", "DZ": "algeria", "AD": "andorra", "AO": "angola", "AR": "argentina",
	"AM": "armenia", "AU": "australia", "AT": "austria", "AZ": "azerbaijan", "BS": "bahamas", "BH": "bahrain",
	"BD": "bangladesh", "BB": "barbados", "BY": "belarus", "BE": "belgium", "BZ": "belize", "BJ": "benin",
	"BT": "bhutan", "BO": "bolivia", "BA": "bosnia and herzegovina", "BW": "botswana", "BR": "brazil", "BN": "brunei",
	"BG": "bulgaria", "BF": "burkina faso", "BI": "burundi", "KH": "cambodia", "CM": "cameroon", "CA": "canada",
	"CV": "cape verde", "CF": "central african republic", "TD": "chad", "CL": "chile", "CN": "china", "CO": "colombia",
	"KM": "comoros", "CG": "congo", "CR": "costa rica", "HR": "croatia", "CU": "cuba", "CY": "cyprus",
	"CZ": "czech republic", "DK": "denmark", "DJ": "djibouti", "DO": "dominican republic", "EC": "ecuador", "EG": "egypt",
	"SV": "el salvador", "GQ": "equatorial guinea", "ER": "eritrea", "EE": "estonia", "ET": "ethiopia", "FJ": "fiji",
	"FI": "finland", "FR": "france", "GA": "gabon", "GM": "gambia", "GE": "georgia", "DE": "germany",
	"GH": "ghana", "GR": "greece", "GT": "guatemala", "GN": "guinea", "HT": "haiti", "HN": "honduras",
	"HU": "hungary", "IS": "iceland", "IN": "india", "ID": "indonesia", "IR": "iran", "IQ": "iraq",
	"IE": "ireland", "IL": "israel", "IT": "italy", "JM": "jamaica", "JP": "japan", "JO": "jordan",
	"KZ": "kazakhstan", "KE": "kenya", "KW": "kuwait", "KG": "kyrgyzstan", "LV": "latvia", "LB": "lebanon",
	"LS": "lesotho", "LR": "liberia", "LY": "libya", "LI": "liechtenstein", "LT": "lithuania", "LU": "luxembourg",
	"MG": "madagascar", "MW": "malawi", "MY": "malaysia", "MV": "maldives", "ML": "mali", "MT": "malta",
	"MR": "mauritania", "MU": "mauritius", "MX": "mexico", "MD": "moldova", "MC": "monaco", "MN": "mongolia",
	"ME": "montenegro", "MA": "morocco", "MZ": "mozambique", "MM": "myanmar", "NA": "namibia", "NP": "nepal",
	"NL": "netherlands", "NZ": "new zealand", "NI": "nicaragua", "NE": "niger", "NG": "nigeria", "KP": "north korea",
	"MK": "north macedonia", "NO": "norway", "OM": "oman", "PK": "pakistan", "PA": "panama", "PG": "papua new guinea",
	"PY": "paraguay", "PE": "peru", "PH": "philippines", "PL": "poland", "PT": "portugal", "QA": "qatar",
	"RO": "romania", "RU": "russia", "RW": "rwanda", "SA": "saudi arabia", "SN": "senegal", "RS": "serbia",
	"SG": "singapore", "SK": "slovakia", "SI": "slovenia", "SO": "somalia", "ZA": "south africa", "KR": "south korea",
	"SS": "south sudan", "ES": "spain", "LK": "sri lanka", "SD": "sudan", "SE": "sweden", "CH": "switzerland",
	"SY": "syria", "TW": "taiwan", "TJ": "tajikistan", "TZ": "tanzania", "TH": "thailand", "TG": "togo",
	"TT": "trinidad and tobago", "TN": "tunisia", "TR": "turkey", "TM": "turkmenistan", "UG": "uganda", "UA": "ukraine",
	"AE": "united arab emirates", "GB": "united kingdom", "US": "united states", "UY": "uruguay", "UZ": "uzbekistan",
	"VE": "venezuela", "VN": "vietnam", "YE": "yemen", "ZM": "zambia", "ZW": "zimbabwe",
}
