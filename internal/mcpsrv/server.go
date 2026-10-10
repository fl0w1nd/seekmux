// Package mcpsrv exposes the gateway tools over MCP streamable HTTP,
// authorized by API keys.
package mcpsrv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/fl0w1nd/seekmux/internal/app"
	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/fetch"
	"github.com/fl0w1nd/seekmux/internal/research"
	"github.com/fl0w1nd/seekmux/internal/search"
	"github.com/fl0w1nd/seekmux/internal/store"
)

type callerKey struct{}

// Handler serves the MCP endpoint.
func Handler(a *app.App, version string) http.Handler {
	streamable := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		key, _ := r.Context().Value(callerKey{}).(store.APIKey)
		return newServer(a, key, version)
	}, &mcp.StreamableHTTPOptions{
		// Every request builds its tool list from the current configuration
		// and the calling key, so there is no session to keep.
		Stateless: true,
		// Calls are authorized by API key, and the usual deployment is behind
		// a reverse proxy on localhost, which this protection would reject.
		DisableLocalhostProtection: true,
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secret := bearer(r)
		key, ok, err := a.Store.LookupAPIKey(r.Context(), secret)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if !ok {
			w.Header().Set("WWW-Authenticate", `Bearer realm="seekmux"`)
			http.Error(w, "missing or invalid API key", http.StatusUnauthorized)
			return
		}
		if time.Since(time.UnixMilli(key.LastUsedAt)) > time.Minute {
			a.Store.TouchAPIKey(r.Context(), key.ID)
		}
		streamable.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, key)))
	})
}

func bearer(r *http.Request) string {
	if scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " "); ok && strings.EqualFold(scheme, "Bearer") {
		return strings.TrimSpace(token)
	}
	return r.Header.Get("X-API-Key")
}

// rateLimited enforces the calling key's own rate limit on a tool call.
func rateLimited(a *app.App, key store.APIKey) error {
	limit, err := config.ParseRateLimit(key.RateLimit)
	if err != nil || limit.Requests <= 0 {
		return nil
	}
	if ok, wait := a.Limits.Rate.TryAcquire("key:"+strconv.FormatInt(key.ID, 10), limit); !ok {
		return fmt.Errorf("API key rate limit (%s) exceeded; retry in %ds", key.RateLimit, int(math.Ceil(wait.Seconds())))
	}
	return nil
}

func schema(raw string) *jsonschema.Schema {
	var s jsonschema.Schema
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		panic(fmt.Sprintf("invalid tool schema: %v", err))
	}
	return &s
}

func enum(values []string) string {
	data, _ := json.Marshal(values)
	return string(data)
}

func text(v any, indent bool) *mcp.CallToolResult {
	var data []byte
	if indent {
		data, _ = json.MarshalIndent(v, "", "  ")
	} else {
		data, _ = json.Marshal(v)
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}
}

func failure(err error) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}, IsError: true}
}

const fetchDescription = "Fetch a web page and answer `prompt` against it. A helper model reads the entire page and returns only what the prompt asks for.\n" +
	"- Ask for exactly what you need and how detailed it should be. Ask for code, commands or exact wording verbatim when you need them verbatim.\n" +
	"- Follow-up questions about the same URL are cheap: the page is cached for a few minutes.\n" +
	"- Short pages and source-code files are returned as original text instead of an answer.\n" +
	"- Set `raw` only when you need the original text itself, e.g. to copy a long passage or to double-check an answer."

const devSearchDescription = "Search an index of public code repositories and documentation sites: issues, merged pull requests, READMEs and docs. " +
	"Each result comes with the passages that matched, so it can often be used without fetching the page.\n" +
	"- Use it for questions about a library, framework or tool: how to use or configure it, what an error means, whether a bug is known or fixed.\n" +
	"- Ask in natural language and name the library. For anything else, and for news or recent releases, use `search`.\n" +
	"- The index holds no source code; to read a file, `fetch` its URL."

const researchDescription = "Hand a question to a research agent that searches and reads the web on its own, then returns a sourced report. " +
	"Use it for questions that need many searches and pages to answer; for a quick lookup use `search` and `fetch` yourself. " +
	"State the question completely, with the context and constraints that matter: the agent knows nothing about your conversation. A run takes minutes. " +
	"The report is followed by a note on how the run ended and on any link it cites without having read the page."

func newServer(a *app.App, key store.APIKey, version string) *mcp.Server {
	snap := a.Snapshot()
	caller := app.Caller{Source: app.SourceMCP, KeyID: key.ID, KeyName: key.Name}
	server := mcp.NewServer(&mcp.Implementation{Name: "seekmux", Title: "SeekMux", Version: version}, nil)
	allowed := func(tool string) bool { return slices.Contains(key.Scopes, tool) }

	if allowed(config.ToolSearch) {
		mcp.AddTool(server, &mcp.Tool{
			Name:        "search",
			Description: "Search the web and return relevant results.",
			InputSchema: schema(`{
				"type": "object",
				"required": ["queries"],
				"properties": {
					"queries": {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1},
						"description": "At most three search queries. Example: [\"what is mcp?\", \"2026 Model context protocol\"]"},
					"maxResults": {"type": "integer", "minimum": 1, "maximum": 100, "default": 5, "description": "Max results per query"},
					"time_range": {"type": "string", "enum": ` + enum(search.TimeRanges) + `,
						"description": "Limit results to a recent publication window. Use for freshness-sensitive research."},
					"include_domains": {"type": "array", "maxItems": ` + strconv.Itoa(search.MaxDomains) + `, "items": {"type": "string"},
						"description": "Only return results from these domains and their subdomains. Example: [\"docs.python.org\", \"github.com\"]"},
					"exclude_domains": {"type": "array", "maxItems": ` + strconv.Itoa(search.MaxDomains) + `, "items": {"type": "string"},
						"description": "Never return results from these domains."},
					"search_engine": {"type": "string", "enum": ` + enum(search.Engines(snap.Config)) + `, "default": "auto",
						"description": "Search provider: auto or any configured provider"}
				}
			}`),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, args search.Args) (*mcp.CallToolResult, any, error) {
			if err := rateLimited(a, key); err != nil {
				return failure(err), nil, nil
			}
			results, err := a.Search(ctx, caller, args, app.Override{})
			if err != nil {
				return failure(err), nil, nil
			}
			return text(results, true), nil, nil
		})
	}

	if allowed(config.ToolDevSearch) && search.DevAvailable(snap.Config) {
		mcp.AddTool(server, &mcp.Tool{
			Name:        "dev_search",
			Description: devSearchDescription,
			InputSchema: schema(`{
				"type": "object",
				"required": ["query"],
				"properties": {
					"query": {"type": "string", "minLength": 1,
						"description": "A natural-language question. Example: \"how do I configure retries in the go-sdk streamable HTTP client\""},
					"maxResults": {"type": "integer", "minimum": 1, "maximum": ` + strconv.Itoa(search.DevMaxResults) + `, "default": 5, "description": "Max results"},
					"types": {"type": "array", "items": {"type": "string", "enum": ` + enum(search.DevTypes) + `},
						"description": "Only return these kinds of result. Default: all."},
					"repos": {"type": "array", "maxItems": ` + strconv.Itoa(search.DevMaxRepos) + `, "items": {"type": "string"},
						"description": "Only search the issues, pull requests and READMEs of these repositories. Example: [\"modelcontextprotocol/go-sdk\"]"}
				}
			}`),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, args search.DevArgs) (*mcp.CallToolResult, any, error) {
			if err := rateLimited(a, key); err != nil {
				return failure(err), nil, nil
			}
			result, err := a.DevSearch(ctx, caller, args, app.Override{})
			if err != nil {
				return failure(err), nil, nil
			}
			if result.Error != "" {
				return failure(errors.New(result.Error)), nil, nil
			}
			return text(result, true), nil, nil
		})
	}

	if allowed(config.ToolFetch) {
		mcp.AddTool(server, &mcp.Tool{
			Name:        "fetch",
			Description: fetchDescription,
			InputSchema: schema(`{
				"type": "object",
				"required": ["url", "prompt"],
				"properties": {
					"url": {"type": "string", "description": "URL to fetch."},
					"prompt": {"type": "string",
						"description": "What you want from the page: a question or an extraction instruction. State the scope and level of detail, e.g. \"List every rate limit with its exact numbers\" or \"Show the full streaming example, code verbatim\"."},
					"raw": {"type": "boolean", "default": false,
						"description": "Return the page's original markdown instead of an answer (` + "`prompt`" + ` is then ignored). Costs far more context than an answer; use it only when you need the original text."},
					"offset": {"type": "integer", "minimum": 0, "default": 0,
						"description": "Position to start from. Pass the ` + "`next_offset`" + ` of a previous result to continue a page that did not fit in one call."},
					"fetch_engine": {"type": "string", "enum": ` + enum(fetch.Engines(snap.Config)) + `, "default": "auto", "description": "Fetch provider"}
				}
			}`),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, args fetch.Args) (*mcp.CallToolResult, any, error) {
			if err := rateLimited(a, key); err != nil {
				return failure(err), nil, nil
			}
			result, err := a.Fetch(ctx, caller, args, app.Override{})
			if err != nil {
				return failure(err), nil, nil
			}
			return text(result, false), nil, nil
		})
	}

	if allowed(config.ToolResearch) && app.ResearchAvailable(snap) {
		addResearchTools(server, a, key, caller)
	}
	return server
}

type researchArgs struct {
	research.Request
	Effort string `json:"effort"`
}

// override is the budget the caller chose for the run.
func (a researchArgs) override() (app.Override, error) {
	switch a.Effort {
	case "", effortFull:
		return app.Override{}, nil
	case effortQuick:
		return app.Override{Research: app.ResearchOverride{Quick: true}}, nil
	}
	return app.Override{}, fmt.Errorf("effort must be %q or %q", effortQuick, effortFull)
}

const (
	effortQuick = "quick"
	effortFull  = "full"
)

type taskArgs struct {
	TaskID string `json:"task_id"`
}

var questionSchema = `{
	"type": "object",
	"required": ["question"],
	"properties": {
		"question": {"type": "string", "minLength": 1,
			"description": "The question to research, self-contained: include the context, constraints and the form of answer you need. Name the URLs of any pages the agent should start from."},
		"include_domains": {"type": "array", "maxItems": ` + strconv.Itoa(search.MaxDomains) + `, "items": {"type": "string"},
			"description": "Limit the agent's web searches to these domains and their subdomains, e.g. the documentation site of the library in question."},
		"exclude_domains": {"type": "array", "maxItems": ` + strconv.Itoa(search.MaxDomains) + `, "items": {"type": "string"},
			"description": "Keep these domains out of the agent's web searches."},
		"effort": {"type": "string", "enum": ` + enum([]string{effortQuick, effortFull}) + `, "default": "` + effortFull + `",
			"description": "quick: a short run on about a third of the budget, for a question a few pages can answer. full: the whole budget."}
	}
}`

// limitWords names a research limit to the caller.
var limitWords = map[string]string{
	research.LimitSteps:    "step",
	research.LimitDuration: "time",
	research.LimitTokens:   "token",
	research.LimitContext:  "context",
}

func bullets(urls []string) string {
	return "\n- " + strings.Join(urls, "\n- ")
}

// finished is a report with what its text cannot tell the caller: whether
// the agent was cut short, and which of its citations it never read.
func finished(report string, r research.Result) *mcp.CallToolResult {
	// A task kept from before runs recorded their totals has only its report.
	if !r.Ran() {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: report}}}
	}
	var note strings.Builder
	switch {
	case r.Exhausted != "":
		fmt.Fprintf(&note, "Research run: cut short. The %s budget ran out before the agent was done, so it wrote the report from what it had gathered; the report may be incomplete.", limitWords[r.Exhausted])
	case r.BudgetExhausted:
		note.WriteString("Research run: cut short. The budget ran out before the agent was done, so it wrote the report from what it had gathered; the report may be incomplete.")
	default:
		note.WriteString("Research run: the agent finished on its own.")
	}
	fmt.Fprintf(&note, " %d searches, %d page reads.", r.Searches+r.DevSearches, r.Fetches)
	if len(r.Unread) > 0 {
		note.WriteString("\n\nCited in the report although the agent never read the page. These links come from search snippets or the model's memory; treat what they are cited for as unverified:" + bullets(r.Unread))
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: report + "\n\n---\n" + note.String()}}}
}

// unfinished is the error of a run that wrote no report, with what the run
// leaves the caller to go on.
func unfinished(message string, read []string, draft string) *mcp.CallToolResult {
	if len(read) > 0 {
		message += "\n\nPages the agent had read by then:" + bullets(read)
	}
	if draft != "" {
		message += "\n\nWhat the agent was writing when it stopped, unfinished and possibly only a note to itself:\n" + draft
	}
	return failure(errors.New(message))
}

func addResearchTools(server *mcp.Server, a *app.App, key store.APIKey, caller app.Caller) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "research",
		Description: researchDescription + " The call returns when the report is ready; if your client times out on long calls, use `research_start` instead.",
		InputSchema: schema(questionSchema),
	}, func(ctx context.Context, req *mcp.CallToolRequest, args researchArgs) (*mcp.CallToolResult, any, error) {
		override, err := args.override()
		if err != nil {
			return failure(err), nil, nil
		}
		if err := rateLimited(a, key); err != nil {
			return failure(err), nil, nil
		}
		// Progress notifications double as keep-alives on the response stream.
		var progress func(research.Event)
		if token := req.Params.GetProgressToken(); token != nil {
			step := 0.0
			progress = func(event research.Event) {
				line := event.Line()
				if line == "" {
					return
				}
				step++
				_ = req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: token, Progress: step, Message: line})
			}
		}
		result, err := a.Research(ctx, caller, args.Request, override, progress)
		if err != nil {
			return unfinished(err.Error(), result.Read, result.Draft), nil, nil
		}
		return finished(result.Report, result), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "research_start",
		Description: researchDescription + " Returns a task id immediately; poll `research_result` with it for the report.",
		InputSchema: schema(questionSchema),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, args researchArgs) (*mcp.CallToolResult, any, error) {
		override, err := args.override()
		if err != nil {
			return failure(err), nil, nil
		}
		if err := rateLimited(a, key); err != nil {
			return failure(err), nil, nil
		}
		id, err := a.StartResearch(ctx, caller, args.Request, override)
		if err != nil {
			return failure(err), nil, nil
		}
		return text(map[string]string{
			"task_id": id,
			"status":  store.TaskRunning,
			"next":    "Call research_result with this task_id. A run usually takes a few minutes.",
		}, false), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "research_result",
		Description: "Get the status of a research task started with `research_start`, and its report once it is done. While the task is running the call waits up to 25 seconds for it to finish.",
		InputSchema: schema(`{
			"type": "object",
			"required": ["task_id"],
			"properties": {"task_id": {"type": "string", "description": "The task id returned by research_start."}}
		}`),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, args taskArgs) (*mcp.CallToolResult, any, error) {
		deadline := time.Now().Add(25 * time.Second)
		for {
			task, ok, err := a.Store.GetTask(ctx, strings.TrimSpace(args.TaskID))
			if err != nil {
				return failure(err), nil, nil
			}
			if !ok {
				return failure(fmt.Errorf("unknown task_id; tasks are kept for 7 days")), nil, nil
			}
			// A task that ended before its first step has no stats.
			var stats research.Result
			if len(task.Stats) > 0 {
				_ = json.Unmarshal(task.Stats, &stats)
			}
			switch {
			case task.Status == store.TaskDone:
				return finished(task.Result, stats), nil, nil
			case task.Status == store.TaskFailed, task.Status == store.TaskCanceled:
				return unfinished("research failed: "+task.Error, stats.Read, strings.TrimSpace(task.Draft)), nil, nil
			case time.Now().After(deadline):
				return text(map[string]string{
					"status":   task.Status,
					"progress": task.Progress,
					"next":     "Still running. Call research_result again.",
				}, false), nil, nil
			}
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
				return failure(ctx.Err()), nil, nil
			}
		}
	})
}
