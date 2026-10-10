// Package research runs the research agent: a model that searches and reads
// the web through the same search, dev_search and fetch tools the gateway
// exposes, then writes a sourced report.
package research

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"charm.land/fantasy"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/fetch"
	"github.com/fl0w1nd/seekmux/internal/llm"
	"github.com/fl0w1nd/seekmux/internal/search"
)

// DefaultSystemPrompt instructs the research agent. {{date}} is replaced by
// today's date, in custom prompts too.
const DefaultSystemPrompt = `You are a research agent. Another AI model handed you a question it cannot answer from its own knowledge. Investigate it on the web and write the report it will rely on. That report is all it will see of your work.

How to work:
- Start by searching. Run several differently worded queries at once rather than one at a time, and use time_range when the question is about recent events.
- Search results are leads, not evidence. Open the pages that matter with fetch and go by what they actually say. Fetch several pages in the same step when you can.
- Prefer primary sources: official documentation, source code, standards, papers, first-party announcements. Check a claim that matters against a second independent source.
- A page that fails to load proves nothing either way. Try another source, and report the point as unverified rather than as absent.
- Follow up on what you learn: new terms, version numbers, names and dates are better queries than your first guesses.
- Stop when further searching would no longer change the report. You have a limited budget of steps; when told it is used up, write the report from what you have.

The report:
- Lead with the direct answer to the question, then the supporting detail.
- State facts precisely: exact names, numbers, versions, dates, commands and code as the sources give them.
- Cite the source URL inline after each claim it supports, and end with a "Sources" list of the URLs you actually used.
- Say plainly what you could not find or verify, and where sources disagree. Never fill a gap with a guess.
- Write in the language of the question. No preamble and no account of your process.

Today's date is {{date}}.`

// devSearchHint is added to the default prompt when the agent has dev_search.
const devSearchHint = `

You also have dev_search, which searches the issues, pull requests and READMEs of public code repositories and documentation sites. When the question is about a library, framework, API, tool or an error message, use it alongside search: it finds maintainer answers and documentation passages that web search misses. It does not cover the open web.`

const finalNudge = "The research budget is used up. Do not call any more tools. Write the final report now from what you have gathered, following the report rules."

// Tools are the gateway tools the agent may call.
type Tools struct {
	Search func(ctx context.Context, args search.Args) ([]search.QueryResult, error)
	// DevSearch is nil when no dev_search provider can serve; the agent is
	// then not offered the tool.
	DevSearch func(ctx context.Context, args search.DevArgs) (search.DevResult, error)
	Fetch     func(ctx context.Context, args fetch.Args) (fetch.Result, error)
}

// Request is what a caller asks of a run.
type Request struct {
	Question string `json:"question"`
	// IncludeDomains and ExcludeDomains bound every web search of the run,
	// as search.Args takes them.
	IncludeDomains []string `json:"include_domains,omitempty"`
	ExcludeDomains []string `json:"exclude_domains,omitempty"`
}

// Validate checks the request and puts it in the form Run takes.
func (r *Request) Validate() error {
	if r.Question = strings.TrimSpace(r.Question); r.Question == "" {
		return errors.New("question is required")
	}
	var err error
	r.IncludeDomains, r.ExcludeDomains, err = search.CleanDomains(r.IncludeDomains, r.ExcludeDomains)
	return err
}

// prompt is the question as the agent gets it. The agent is told of the
// domain filters, or it would take a thin result for all there is.
func (r Request) prompt() string {
	prompt := r.Question
	if len(r.IncludeDomains) > 0 {
		prompt += "\n\nThe caller limited this research: your web searches only return results from " + strings.Join(r.IncludeDomains, ", ") + "."
	}
	if len(r.ExcludeDomains) > 0 {
		prompt += "\n\nThe caller ruled out these sites, which your web searches never return: " + strings.Join(r.ExcludeDomains, ", ") + "."
	}
	return prompt
}

// Result is the outcome of a research run.
type Result struct {
	Report string `json:"report"`
	Steps  int    `json:"steps"`
	// BudgetExhausted is set when the agent was made to stop and report, and
	// Exhausted names the limit that did it.
	BudgetExhausted bool   `json:"budget_exhausted,omitempty"`
	Exhausted       string `json:"exhausted,omitempty"`
	Searches        int    `json:"searches"`
	DevSearches     int    `json:"dev_searches,omitempty"`
	Fetches         int    `json:"fetches"`
	// Read lists the pages the agent read, in the order it opened them.
	Read []string `json:"read,omitempty"`
	// Unread lists the URLs the report cites although the agent never had
	// their text: it neither read them nor got passages of them from
	// dev_search.
	Unread []string `json:"unread,omitempty"`
	// Draft is what the model was writing when a run failed.
	Draft string `json:"draft,omitempty"`
	core.Usage
}

// Ran reports whether the run got far enough to have anything to show.
func (r Result) Ran() bool {
	return r.Steps > 0 || r.Searches+r.DevSearches+r.Fetches > 0
}

// The limits of the budget, as Spent.Exhausted names them.
const (
	LimitSteps    = "steps"
	LimitDuration = "duration"
	LimitTokens   = "tokens"
	LimitContext  = "context"
)

// Spent is how much of its budget a run has used so far.
type Spent struct {
	// Steps counts the model rounds begun, the one under way included.
	Steps       int `json:"steps"`
	Searches    int `json:"searches"`
	DevSearches int `json:"dev_searches,omitempty"`
	Fetches     int `json:"fetches"`
	// Usage sums the rounds the model has finished.
	core.Usage
	// ContextTokens estimates the size of the next request to the model.
	ContextTokens int64 `json:"context_tokens"`
	// Exhausted names the limit that made the agent stop and report.
	Exhausted string `json:"exhausted,omitempty"`
}

// What an Event reports the agent doing.
const (
	EventSearch    = "search"
	EventDevSearch = "dev_search"
	EventFetch     = "fetch"
	// EventNote is what the model said before calling tools in a step.
	EventNote = "note"
	// EventWrapUp marks the budget running out; Text names the limit.
	EventWrapUp = "wrap_up"
)

// Event is one report of a run under way. Kind is empty when only the totals
// or the draft moved.
type Event struct {
	// Step is the model round the event belongs to, from 1.
	Step int
	Kind string
	Text string
	// Spent is the budget used by now.
	Spent Spent
	// Draft is what the model has written so far in the current step: the
	// report in the making, unless the step goes on to call tools.
	Draft string
}

// Line words the event as a status line. It is empty for an event that is
// not worth one: totals that moved, or the agent thinking aloud.
func (e Event) Line() string {
	switch e.Kind {
	case EventSearch, EventDevSearch, EventFetch:
		return e.Kind + ": " + e.Text
	case EventWrapUp:
		return "budget used up, writing the report"
	}
	return ""
}

// maxNote bounds what is kept of the model's words between tool calls.
const maxNote = 1200

type searchInput struct {
	Queries   []string `json:"queries" description:"One to three search queries, each worded differently."`
	TimeRange string   `json:"time_range,omitempty" enum:"day,week,month,year" description:"Limit results to a recent publication window. Omit unless freshness matters."`
}

type devSearchInput struct {
	Query string   `json:"query" description:"A natural-language question that names the library, framework or tool."`
	Types []string `json:"types,omitempty" description:"Only return these kinds of result, among: doc, issue, pull_request, readme. Omit for all."`
	Repos []string `json:"repos,omitempty" description:"Only search the issues, pull requests and READMEs of these repositories, each as owner/name."`
}

type readInput struct {
	URL    string `json:"url" description:"URL of the page to read."`
	Offset int    `json:"offset,omitempty" description:"Where to continue a long page: the next_offset of the previous part. Omit to start at the top."`
}

type fetchInput struct {
	URL    string `json:"url" description:"URL of the page to read."`
	Prompt string `json:"prompt" description:"What you want from the page: a question or an extraction instruction, with the scope and level of detail you need."`
}

// Run investigates the question of req, which must have passed Validate. progress receives an event for every tool
// call the agent makes and whenever the budget it has spent moves.
func Run(ctx context.Context, cfg config.Research, model *llm.Model, tools Tools, req Request, progress func(Event)) (Result, error) {
	if progress == nil {
		progress = func(Event) {}
	}
	trace := core.TraceFrom(ctx)
	started := time.Now()
	budget := time.Duration(cfg.MaxDurationSeconds) * time.Second
	// The agent is told to wrap up before the budget ends, so the report
	// itself still fits; the hard limit only catches a stuck run.
	wrapUpAt := started.Add(budget * 4 / 5)
	ctx, cancel := context.WithTimeout(ctx, budget+2*time.Minute)
	defer cancel()

	// Tools run in parallel, so everything a report carries sits behind mu.
	var (
		mu    sync.Mutex
		spent Spent
		step  int
		draft strings.Builder
		// settled is the size of the last request and its answer; gathered
		// counts the bytes of tool output the model has not been sent yet,
		// taken as three bytes to the token.
		settled, gathered int64
		drafted           time.Time
		// known holds the pages whose text the agent was given, by pageKey.
		known = map[string]bool{}
		pages []string
	)
	report := func(kind, text string, change func()) {
		mu.Lock()
		if change != nil {
			change()
		}
		spent.ContextTokens = settled + gathered/3
		event := Event{Step: step, Kind: kind, Text: text, Spent: spent, Draft: draft.String()}
		mu.Unlock()
		progress(event)
	}

	jsonResponse := func(v any) fantasy.ToolResponse {
		data, err := json.Marshal(v)
		if err != nil {
			return fantasy.NewTextErrorResponse(err.Error())
		}
		report("", "", func() { gathered += int64(len(data)) })
		return fantasy.NewTextResponse(string(data))
	}
	searchTool := fantasy.NewParallelAgentTool("search", "Search the web and return relevant results.",
		func(ctx context.Context, in searchInput, _ fantasy.ToolCall) (fantasy.ToolResponse, error) {
			report(EventSearch, strings.Join(in.Queries, " | "), func() { spent.Searches++ })
			out, err := tools.Search(ctx, search.Args{
				Queries: in.Queries, MaxResults: 6, TimeRange: in.TimeRange,
				IncludeDomains: req.IncludeDomains, ExcludeDomains: req.ExcludeDomains,
			})
			if err != nil {
				return fantasy.NewTextErrorResponse(err.Error()), nil
			}
			return jsonResponse(out), nil
		})
	devSearchTool := fantasy.NewParallelAgentTool("dev_search", "Search the issues, pull requests and READMEs of public code repositories and documentation sites. Each result carries the passages that matched.",
		func(ctx context.Context, in devSearchInput, _ fantasy.ToolCall) (fantasy.ToolResponse, error) {
			report(EventDevSearch, in.Query, func() { spent.DevSearches++ })
			out, err := tools.DevSearch(ctx, search.DevArgs{Query: in.Query, Types: in.Types, Repos: in.Repos})
			if err != nil {
				return fantasy.NewTextErrorResponse(err.Error()), nil
			}
			if out.Error != "" {
				return fantasy.NewTextErrorResponse(out.Error), nil
			}
			// A result carries the passages that matched: the agent has read
			// that much of the page.
			mu.Lock()
			for _, item := range out.Results {
				known[pageKey(item.URL)] = true
			}
			mu.Unlock()
			return jsonResponse(out), nil
		})
	read := func(ctx context.Context, args fetch.Args) (fantasy.ToolResponse, error) {
		report(EventFetch, args.URL, func() { spent.Fetches++ })
		out, err := tools.Fetch(ctx, args)
		if err != nil {
			return fantasy.NewTextErrorResponse(err.Error()), nil
		}
		if key := pageKey(args.URL); out.Error == "" {
			mu.Lock()
			if !known[key] {
				pages = append(pages, args.URL)
			}
			known[key] = true
			mu.Unlock()
		}
		return jsonResponse(out), nil
	}
	// Reading the text itself keeps the agent on primary material; having the
	// extract models answer per page costs it far less context.
	page := func(name, description string) fantasy.AgentTool {
		return fantasy.NewParallelAgentTool(name, description+" A long page comes in parts: when the result has next_offset, call again with it to read on.",
			func(ctx context.Context, in readInput, _ fantasy.ToolCall) (fantasy.ToolResponse, error) {
				return read(ctx, fetch.Args{URL: in.URL, Raw: true, Offset: in.Offset})
			})
	}
	readers := []fantasy.AgentTool{page("fetch", "Read the text of a web page.")}
	if cfg.Reading == config.ReadingExtract {
		// An answer is only as good as the extract model's reading, so the
		// text stays within reach for the pages where that is not enough.
		readers = []fantasy.AgentTool{
			fantasy.NewParallelAgentTool("fetch", "Read a web page and get the answer to your prompt from its content.",
				func(ctx context.Context, in fetchInput, _ fantasy.ToolCall) (fantasy.ToolResponse, error) {
					return read(ctx, fetch.Args{URL: in.URL, Prompt: in.Prompt})
				}),
			page("read_page", "Read the original text of a web page instead of an answer about it. This costs far more context than fetch: keep it for code, commands and exact wording, and for checking an answer that matters."),
		}
	}

	offered := []fantasy.AgentTool{searchTool}
	system := cfg.SystemPrompt
	if strings.TrimSpace(system) == "" {
		system = DefaultSystemPrompt
		// A custom prompt is left as written; the tool's description speaks for it there.
		if tools.DevSearch != nil {
			system += devSearchHint
		}
	}
	if tools.DevSearch != nil {
		offered = append(offered, devSearchTool)
	}
	offered = append(offered, readers...)
	system = strings.ReplaceAll(system, "{{date}}", started.Format("2006-01-02"))
	agent := fantasy.NewAgent(model.Language, fantasy.WithSystemPrompt(system), fantasy.WithTools(offered...))

	var result Result
	done := trace.Begin("llm", model.Label, "")
	out, err := agent.Stream(ctx, fantasy.AgentStreamCall{
		Prompt:          req.prompt(),
		ProviderOptions: model.Options,
		MaxOutputTokens: model.MaxOutputTokens,
		// One step past the budget is reserved for the report.
		StopWhen: []fantasy.StopCondition{fantasy.StepCountIs(cfg.MaxSteps + 1)},
		PrepareStep: func(ctx context.Context, opt fantasy.PrepareStepFunctionOptions) (context.Context, fantasy.PrepareStepResult, error) {
			// The next request carries the last one, its answer and the tool
			// output since.
			var total core.Usage
			var last int64
			for _, s := range opt.Steps {
				usage := llm.Usage(s.Usage)
				total = total.Add(usage)
				last = usage.InputTokens + usage.OutputTokens
			}
			mu.Lock()
			context := last + gathered/3
			mu.Unlock()

			limit := ""
			switch {
			case opt.StepNumber >= cfg.MaxSteps:
				limit = LimitSteps
			case !time.Now().Before(wrapUpAt):
				limit = LimitDuration
			case total.InputTokens+total.OutputTokens >= cfg.MaxTokens:
				limit = LimitTokens
			case context >= cfg.MaxContextTokens:
				limit = LimitContext
			}
			settle := func() {
				step = opt.StepNumber + 1
				spent.Steps, spent.Usage = step, total
				settled, gathered = context, 0
				draft.Reset()
			}
			if limit == "" {
				report("", "", settle)
				return ctx, fantasy.PrepareStepResult{Messages: model.CachePrefix(opt.Messages)}, nil
			}
			result.BudgetExhausted, result.Exhausted = true, limit
			report(EventWrapUp, limit, func() {
				settle()
				spent.Exhausted = limit
			})
			messages := append(append([]fantasy.Message(nil), opt.Messages...), fantasy.NewUserMessage(finalNudge))
			return ctx, fantasy.PrepareStepResult{Messages: messages, DisableAllTools: true}, nil
		},
		OnTextDelta: func(_, text string) error {
			mu.Lock()
			draft.WriteString(text)
			due := time.Since(drafted) >= 250*time.Millisecond
			if due {
				drafted = time.Now()
			}
			mu.Unlock()
			if due {
				report("", "", nil)
			}
			return nil
		},
		// The request is answered before its tools run, so the totals move
		// here rather than once the step is over.
		OnStreamFinish: func(u fantasy.Usage, _ fantasy.FinishReason, _ fantasy.ProviderMetadata) error {
			usage := llm.Usage(u)
			report("", "", func() {
				spent.Usage = spent.Usage.Add(usage)
				settled = usage.InputTokens + usage.OutputTokens
			})
			return nil
		},
		OnStepFinish: func(s fantasy.StepResult) error {
			// Words before a tool call are the agent thinking aloud, not the report.
			note := strings.TrimSpace(s.Content.Text())
			if len(s.Content.ToolCalls()) == 0 || note == "" {
				return nil
			}
			if runes := []rune(note); len(runes) > maxNote {
				note = string(runes[:maxNote]) + "…"
			}
			report(EventNote, note, draft.Reset)
			return nil
		},
	})
	mu.Lock()
	result.Searches, result.DevSearches, result.Fetches = spent.Searches, spent.DevSearches, spent.Fetches
	result.Read = pages
	unfinished := strings.TrimSpace(draft.String())
	mu.Unlock()
	if err != nil {
		result.Draft = unfinished
		err = llm.Describe(err)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = fmt.Errorf("research did not finish within %s", budget+2*time.Minute)
		}
		done(err)
		return result, err
	}
	done(nil)

	result.Steps = len(out.Steps)
	result.Usage = llm.Usage(out.TotalUsage)
	trace.AddUsage(result.Usage)
	result.Report = strings.TrimSpace(out.Response.Content.Text())
	result.Unread = unread(result.Report, known)
	report("", "", func() {
		spent.Steps, spent.Usage = result.Steps, result.Usage
		draft.Reset()
	})
	if result.Report == "" {
		return result, errors.New("the research model finished without writing a report")
	}
	return result, nil
}
