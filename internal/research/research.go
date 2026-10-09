// Package research runs the research agent: a model that searches and reads
// the web through the same search and fetch tools the gateway exposes, then
// writes a sourced report.
package research

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
- Search results are leads, not evidence. Open the pages that matter with fetch and ask each one a precise question. Fetch several pages in the same step when you can.
- Prefer primary sources: official documentation, source code, standards, papers, first-party announcements. Check a claim that matters against a second independent source.
- Follow up on what you learn: new terms, version numbers, names and dates are better queries than your first guesses.
- Stop when further searching would no longer change the report. You have a limited budget of steps; when told it is used up, write the report from what you have.

The report:
- Lead with the direct answer to the question, then the supporting detail.
- State facts precisely: exact names, numbers, versions, dates, commands and code as the sources give them.
- Cite the source URL inline after each claim it supports, and end with a "Sources" list of the URLs you actually used.
- Say plainly what you could not find or verify, and where sources disagree. Never fill a gap with a guess.
- Write in the language of the question. No preamble and no account of your process.

Today's date is {{date}}.`

const finalNudge = "The research budget is used up. Do not call any more tools. Write the final report now from what you have gathered, following the report rules."

// Tools are the gateway tools the agent may call.
type Tools struct {
	Search func(ctx context.Context, args search.Args) ([]search.QueryResult, error)
	Fetch  func(ctx context.Context, args fetch.Args) (fetch.Result, error)
}

// Result is the outcome of a research run.
type Result struct {
	Report string `json:"report"`
	Steps  int    `json:"steps"`
	// BudgetExhausted is set when the agent was made to stop and report.
	BudgetExhausted bool  `json:"budget_exhausted,omitempty"`
	Searches        int   `json:"searches"`
	Fetches         int   `json:"fetches"`
	InputTokens     int64 `json:"input_tokens"`
	OutputTokens    int64 `json:"output_tokens"`
}

type searchInput struct {
	Queries   []string `json:"queries" description:"One to three search queries, each worded differently."`
	TimeRange string   `json:"time_range,omitempty" enum:"day,week,month,year" description:"Limit results to a recent publication window. Omit unless freshness matters."`
}

type fetchInput struct {
	URL    string `json:"url" description:"URL of the page to read."`
	Prompt string `json:"prompt" description:"What you want from the page: a question or an extraction instruction, with the scope and level of detail you need."`
}

// Run investigates the question. progress receives a short line for every
// tool call the agent makes.
func Run(ctx context.Context, cfg config.Research, model *llm.Model, tools Tools, question string, progress func(string)) (Result, error) {
	if progress == nil {
		progress = func(string) {}
	}
	trace := core.TraceFrom(ctx)
	started := time.Now()
	budget := time.Duration(cfg.MaxDurationSeconds) * time.Second
	// The agent is told to wrap up before the budget ends, so the report
	// itself still fits; the hard limit only catches a stuck run.
	wrapUpAt := started.Add(budget * 4 / 5)
	ctx, cancel := context.WithTimeout(ctx, budget+2*time.Minute)
	defer cancel()

	var result Result
	searchTool := fantasy.NewParallelAgentTool("search", "Search the web and return relevant results.",
		func(ctx context.Context, in searchInput, _ fantasy.ToolCall) (fantasy.ToolResponse, error) {
			progress("search: " + strings.Join(in.Queries, " | "))
			out, err := tools.Search(ctx, search.Args{Queries: in.Queries, MaxResults: 6, TimeRange: in.TimeRange})
			if err != nil {
				return fantasy.NewTextErrorResponse(err.Error()), nil
			}
			return jsonResponse(out), nil
		})
	fetchTool := fantasy.NewParallelAgentTool("fetch", "Read a web page and get the answer to your prompt from its content.",
		func(ctx context.Context, in fetchInput, _ fantasy.ToolCall) (fantasy.ToolResponse, error) {
			progress("fetch: " + in.URL)
			out, err := tools.Fetch(ctx, fetch.Args{URL: in.URL, Prompt: in.Prompt})
			if err != nil {
				return fantasy.NewTextErrorResponse(err.Error()), nil
			}
			return jsonResponse(out), nil
		})

	system := cfg.SystemPrompt
	if strings.TrimSpace(system) == "" {
		system = DefaultSystemPrompt
	}
	system = strings.ReplaceAll(system, "{{date}}", started.Format("2006-01-02"))
	agent := fantasy.NewAgent(model.Language, fantasy.WithSystemPrompt(system), fantasy.WithTools(searchTool, fetchTool))

	done := trace.Begin("llm", model.Label, "")
	out, err := agent.Stream(ctx, fantasy.AgentStreamCall{
		Prompt:          question,
		ProviderOptions: model.Options,
		MaxOutputTokens: model.MaxOutputTokens,
		// One step past the budget is reserved for the report.
		StopWhen: []fantasy.StopCondition{fantasy.StepCountIs(cfg.MaxSteps + 1)},
		PrepareStep: func(ctx context.Context, opt fantasy.PrepareStepFunctionOptions) (context.Context, fantasy.PrepareStepResult, error) {
			var tokens int64
			for _, step := range opt.Steps {
				tokens += step.Usage.InputTokens + step.Usage.OutputTokens
			}
			if opt.StepNumber < cfg.MaxSteps && time.Now().Before(wrapUpAt) && tokens < cfg.MaxTokens {
				return ctx, fantasy.PrepareStepResult{}, nil
			}
			result.BudgetExhausted = true
			progress("budget used up, writing the report")
			messages := append(append([]fantasy.Message(nil), opt.Messages...), fantasy.NewUserMessage(finalNudge))
			return ctx, fantasy.PrepareStepResult{Messages: messages, DisableAllTools: true}, nil
		},
		OnToolCall: func(call fantasy.ToolCallContent) error {
			switch call.ToolName {
			case "search":
				result.Searches++
			case "fetch":
				result.Fetches++
			}
			return nil
		},
	})
	if err != nil {
		err = llm.Describe(err)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = fmt.Errorf("research did not finish within %s", budget+2*time.Minute)
		}
		done(err)
		return result, err
	}
	done(nil)

	result.Steps = len(out.Steps)
	result.InputTokens, result.OutputTokens = out.TotalUsage.InputTokens, out.TotalUsage.OutputTokens
	trace.AddUsage(result.InputTokens, result.OutputTokens)
	result.Report = strings.TrimSpace(out.Response.Content.Text())
	if result.Report == "" {
		return result, errors.New("the research model finished without writing a report")
	}
	return result, nil
}

func jsonResponse(v any) fantasy.ToolResponse {
	data, err := json.Marshal(v)
	if err != nil {
		return fantasy.NewTextErrorResponse(err.Error())
	}
	return fantasy.NewTextResponse(string(data))
}
