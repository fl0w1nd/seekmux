package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/fetch"
	"github.com/fl0w1nd/seekmux/internal/research"
	"github.com/fl0w1nd/seekmux/internal/search"
	"github.com/fl0w1nd/seekmux/internal/store"
)

func traceApp(t *testing.T) *App {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	a, err := New(context.Background(), st)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	return a
}

func fakeModelConfig(a *App, base string) *config.Config {
	cfg := a.Snapshot().Config.Clone()
	cfg.LLM.Providers = []config.LLMProvider{{ID: "fake_llm", Name: "Fake", Type: config.LLMOpenAICompatible, BaseURL: base + "/v1", Secret: config.Secret{APIKey: "fake-model-secret"}, Models: []config.Model{{ID: "extract_test", Name: "fake-model", MaxOutputTokens: 1000, Reasoning: config.Reasoning{Mode: "off"}, ExtraBody: map[string]any{"temperature": 0.2}}}}}
	cfg.Fetch.Extract.Models = []string{"extract_test"}
	cfg.Fetch.Extract.MaxOutputTokens = 500
	cfg.Fetch.Extract.FirstChunkTimeoutMs = 1000
	cfg.Fetch.Extract.StreamTotalTimeoutMs = 2000
	cfg.Fetch.Extract.MaxRetries = 1
	cfg.Fetch.PassthroughLength = 1
	cfg.Fetch.Routes = []config.Route{{Provider: "jina", Enabled: true}}
	cfg.Providers["jina"].BaseURL = base
	cfg.Providers["jina"].APIKey = "fake-provider-secret"
	cfg.Fetch.SmartFallback = false
	return cfg
}

func writeModel(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, part := range []string{
		`{"id":"fake","object":"chat.completion.chunk","model":"fake-model","choices":[{"index":0,"delta":{"role":"assistant","content":` + fmt.Sprintf("%q", text) + `},"finish_reason":null}]}`,
		`{"id":"fake","object":"chat.completion.chunk","model":"fake-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}`,
		`[DONE]`,
	} {
		fmt.Fprintf(w, "data: %s\n\n", part)
		w.(http.Flusher).Flush()
	}
}

func TestStoredFetchExtractionTrace(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/chat/completions") {
			writeModel(w, "A fake answer.")
			return
		}
		_, _ = w.Write([]byte(`{"data":{"title":"Fake page","content":"A fake page used only in a test."}}`))
	}))
	defer server.Close()
	a := traceApp(t)
	a.install(fakeModelConfig(a, server.URL))
	trace := core.NewTrace()
	events, stop := trace.Subscribe(256)
	defer stop()
	stored, unsub := a.Logs.Subscribe()
	defer unsub()
	result, err := a.Fetch(core.WithTrace(context.Background(), trace), Caller{Source: SourceWebUI, KeyName: "test", IP: "127.0.0.1"}, fetch.Args{URL: "https://example.test/page", Prompt: "What does the page say?"}, Override{})
	if err != nil || result.Error != "" || result.Answer != "A fake answer." {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	select {
	case entry := <-stored:
		got, found, err := a.Store.GetLogByCall(context.Background(), entry.CallID)
		if err != nil || !found || len(got.Trace) == 0 || got.CallID != trace.CallID {
			t.Fatalf("stored=%+v err=%v", got, err)
		}
		var nodes []core.Node
		if err := json.Unmarshal(got.Trace, &nodes); err != nil {
			t.Fatal(err)
		}
		kinds := []string{"call", "route", "cache", "run", "attempt", "page", "decide", "extract", "cache", "run", "llm", "result"}
		if len(nodes) != len(kinds) {
			t.Fatalf("nodes=%s", got.Trace)
		}
		for i, kind := range kinds {
			if nodes[i].Kind != kind || nodes[i].Status == "running" {
				t.Fatalf("node %d=%+v", i, nodes[i])
			}
		}
		if nodes[10].Parent != 10 || nodes[10].Attrs["role"] != "extract" || nodes[10].Attrs["max_output_tokens"] != float64(500) || nodes[11].Parent != 1 {
			t.Fatalf("llm=%+v result=%+v", nodes[10], nodes[11])
		}
		if strings.Contains(string(got.Trace), "fake-model-secret") || strings.Contains(string(got.Trace), "fake-provider-secret") {
			t.Fatal("trace contains credentials")
		}
		if len(trace.Attempts()) != 2 || trace.Attempts()[0].Kind != "fetch" || trace.Attempts()[1].Kind != "llm" || got.InputTokens != 10 || got.OutputTokens != 3 {
			t.Fatalf("attempts=%+v usage=%+v", trace.Attempts(), got.Usage)
		}
		t.Logf("TRACE_EXAMPLE=%s", got.Trace)
	case <-time.After(2 * time.Second):
		t.Fatal("log not stored")
	}
	text := ""
	for {
		select {
		case e := <-events:
			if e.Text != nil {
				text += e.Text.Delta
			}
		default:
			goto drained
		}
	}
drained:
	if text != "A fake answer." {
		t.Fatalf("model stream=%q", text)
	}
}

func TestCanceledCallResults(t *testing.T) {
	for _, tool := range []string{"search", "dev_search", "fetch", "research"} {
		for _, console := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/console=%v", tool, console), func(t *testing.T) {
				entered := make(chan struct{}, 1)
				abort := make(chan struct{})
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					_, _ = io.Copy(io.Discard, r.Body)
					select {
					case entered <- struct{}{}:
					default:
					}
					select {
					case <-r.Context().Done():
					case <-abort:
					}
				}))
				defer server.Close()
				defer close(abort)
				a := traceApp(t)
				cfg := fakeModelConfig(a, server.URL)
				cfg.Research.Enabled = true
				cfg.Research.Model = "extract_test"
				cfg.Search.Routes = []config.Route{{Provider: "brave", Enabled: true}}
				cfg.DevSearch.Routes = []config.Route{{Provider: "firecrawl", Enabled: true}}
				for _, id := range []string{"brave", "firecrawl"} {
					cfg.Providers[id].BaseURL, cfg.Providers[id].APIKey = server.URL, "fake"
				}
				a.install(cfg)
				registered := make(chan string, 1)
				ctx, disconnect := context.WithCancel(WithCallStart(context.Background(), func(trace *core.Trace) { registered <- trace.CallID }))
				defer disconnect()
				wantErr := ErrCallStopped
				if !console {
					wantErr = context.Canceled
				}
				stored, unsub := a.Logs.Subscribe()
				defer unsub()
				done := make(chan error, 1)
				var taskID string
				switch tool {
				case "search":
					go func() {
						results, err := a.Search(ctx, Caller{Source: SourceMCP}, search.Args{Queries: []string{"fake query"}}, Override{})
						if err == nil && (len(results) != 1 || results[0].Error != wantErr.Error()) {
							err = fmt.Errorf("results=%+v", results)
						}
						done <- err
					}()
				case "dev_search":
					go func() {
						result, err := a.DevSearch(ctx, Caller{Source: SourceMCP}, search.DevArgs{Query: "fake query"}, Override{})
						if err == nil && result.Error != wantErr.Error() {
							err = fmt.Errorf("error=%q", result.Error)
						}
						done <- err
					}()
				case "fetch":
					go func() {
						result, err := a.Fetch(ctx, Caller{Source: SourceMCP}, fetch.Args{URL: "https://example.test/page", Raw: true}, Override{})
						if err == nil && result.Error != wantErr.Error() {
							err = fmt.Errorf("error=%q", result.Error)
						}
						done <- err
					}()
				case "research":
					var err error
					taskID, err = a.createTask(context.Background(), Caller{Source: SourceWebUI}, &research.Request{Question: "Question"}, Override{})
					if err != nil {
						t.Fatal(err)
					}
					go func() {
						_, err := a.runTask(ctx, taskID, Caller{Source: SourceWebUI}, research.Request{Question: "Question"}, Override{}, nil)
						if errors.Is(err, wantErr) {
							err = nil
						}
						done <- err
					}()
				}
				var id string
				select {
				case id = <-registered:
				case <-time.After(2 * time.Second):
					t.Fatal("call never registered")
				}
				select {
				case <-entered:
				case <-time.After(2 * time.Second):
					t.Fatal("upstream never started")
				}
				if console {
					if !a.Live.Cancel(id) {
						t.Fatal("cancel failed")
					}
				} else {
					disconnect()
				}
				select {
				case err := <-done:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("call did not stop")
				}
				select {
				case e := <-stored:
					got, found, err := a.Store.GetLogByCall(context.Background(), e.CallID)
					if err != nil || !found || got.Status != "error" || got.Error != wantErr.Error() {
						t.Fatalf("log=%+v err=%v", got, err)
					}
					var nodes []core.Node
					_ = json.Unmarshal(got.Trace, &nodes)
					if nodes[0].Status != "canceled" || nodes[0].Error != wantErr.Error() {
						t.Fatalf("root=%+v", nodes[0])
					}
					foundResult := false
					for _, n := range nodes {
						if n.Kind == "result" && n.Parent == 1 {
							foundResult = true
							if n.Status != "canceled" || n.Error != wantErr.Error() || n.DurationMs != 0 {
								t.Fatalf("result=%+v", n)
							}
							if tool == "fetch" && n.Attrs["kind"] != "error" {
								t.Fatalf("fetch result=%+v", n)
							}
						}
					}
					if !foundResult {
						t.Fatal("missing result node")
					}
				case <-time.After(2 * time.Second):
					t.Fatal("cancel log not written")
				}
				if tool == "research" {
					task, found, err := a.Store.GetTask(context.Background(), taskID)
					wantStatus, wantMessage := store.TaskCanceled, errCanceled.Error()
					if !console {
						wantStatus, wantMessage = store.TaskFailed, wantErr.Error()
					}
					if err != nil || !found || task.Status != wantStatus || task.Error != wantMessage {
						t.Fatalf("task=%+v err=%v", task, err)
					}
				}
			})
		}
	}
}

func TestResearchTraceNestsToolsAndStreamsSteps(t *testing.T) {
	for _, limited := range []bool{false, true} {
		t.Run(fmt.Sprintf("wrap_up=%v", limited), func(t *testing.T) {
			var rounds atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/chat/completions"):
					if rounds.Add(1) > 1 {
						writeModel(w, "Final report: https://example.test/page")
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					delta := map[string]any{"role": "assistant", "content": "I will inspect the sources.", "tool_calls": []any{
						map[string]any{"index": 0, "id": "s1", "type": "function", "function": map[string]any{"name": "search", "arguments": `{"queries":["fake query"]}`}},
						map[string]any{"index": 1, "id": "d1", "type": "function", "function": map[string]any{"name": "dev_search", "arguments": `{"query":"fake developer query"}`}},
						map[string]any{"index": 2, "id": "f1", "type": "function", "function": map[string]any{"name": "read_page", "arguments": `{"url":"https://example.test/page"}`}},
					}}
					for _, frame := range []map[string]any{
						{"id": "fake", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": nil}}},
						{"id": "fake", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}},
					} {
						b, _ := json.Marshal(frame)
						fmt.Fprintf(w, "data: %s\n\n", b)
					}
					fmt.Fprint(w, "data: [DONE]\n\n")
				case strings.Contains(r.URL.Path, "/search/developer"):
					fmt.Fprint(w, `{"results":[{"url":"https://example.test/dev","type":"doc","passages":[{"text":"fake passage"}]}]}`)
				case strings.Contains(r.URL.Path, "/web/search"):
					fmt.Fprint(w, `{"web":{"results":[{"url":"https://example.test/page","title":"fake"}]}}`)
				default:
					fmt.Fprint(w, `{"data":{"title":"Fake","content":"Fake page"}}`)
				}
			}))
			defer server.Close()
			a := traceApp(t)
			cfg := fakeModelConfig(a, server.URL)
			cfg.Research.Enabled = true
			cfg.Research.Model = "extract_test"
			cfg.Research.Reading = config.ReadingExtract
			cfg.Research.MaxSteps = 5
			if limited {
				cfg.Research.MaxSteps = 1
			}
			cfg.Search.Routes = []config.Route{{Provider: "brave", Enabled: true}}
			cfg.Providers["brave"].BaseURL = server.URL
			cfg.Providers["brave"].APIKey = "fake"
			cfg.DevSearch.Routes = []config.Route{{Provider: "firecrawl", Enabled: true}}
			cfg.Providers["firecrawl"].BaseURL = server.URL
			cfg.Providers["firecrawl"].APIKey = "fake"
			a.install(cfg)
			trace := core.NewTrace()
			events, stop := trace.Subscribe(256)
			defer stop()
			var progress []research.Event
			result, err := a.Research(core.WithTrace(context.Background(), trace), Caller{Source: SourceMCP}, research.Request{Question: "Inspect sources"}, Override{}, func(e research.Event) { progress = append(progress, e) })
			if err != nil || result.Steps != 2 || result.Searches != 1 || result.DevSearches != 1 || result.Fetches != 1 || result.Report == "" || result.BudgetExhausted != limited {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			nodes := trace.Nodes()
			var agent core.Node
			steps := map[string]core.Node{}
			tools := map[string]core.Node{}
			for _, n := range nodes {
				switch n.Kind {
				case "agent":
					agent = n
				case "step":
					steps[n.Name] = n
				case "tool":
					tools[n.Name] = n
				}
				if n.Status == "running" {
					t.Fatalf("running=%+v", n)
				}
			}
			if agent.Parent != 1 || len(steps) != 2 || len(tools) != 3 || steps["1"].Parent != agent.ID || steps["2"].Parent != agent.ID || steps["1"].Attrs["final"] != false || steps["2"].Attrs["final"] != true || steps["1"].Attrs["note"] != "I will inspect the sources." {
				t.Fatalf("agent=%+v steps=%+v tools=%+v", agent, steps, tools)
			}
			for _, tool := range tools {
				if tool.Parent != steps["1"].ID {
					t.Fatalf("tool outside step: %+v", tool)
				}
				hasResult := false
				hasRoute := false
				for _, n := range nodes {
					if n.Parent == tool.ID {
						hasResult = hasResult || n.Kind == "result"
						hasRoute = hasRoute || n.Kind == "route"
					}
				}
				if !hasResult || !hasRoute {
					t.Fatalf("tool lacks subtree: %+v", tool)
				}
			}
			if limited {
				found := false
				for _, n := range nodes {
					if n.Kind == "wrap_up" {
						found = n.Name == "steps" && n.Parent == agent.ID
					}
				}
				if !found {
					t.Fatal("missing wrap_up")
				}
			}
			text := map[int]string{}
			for {
				select {
				case e := <-events:
					if e.Text != nil {
						text[e.Text.Node] += e.Text.Delta
					}
				default:
					goto drained
				}
			}
		drained:
			if text[steps["1"].ID] != "I will inspect the sources." || text[steps["2"].ID] != result.Report {
				t.Fatalf("step text=%v", text)
			}
			noted := false
			for _, e := range progress {
				noted = noted || e.Kind == research.EventNote
			}
			if !noted {
				t.Fatal("existing progress note lost")
			}
			if len(trace.Attempts()) != 4 {
				t.Fatalf("attempts=%+v", trace.Attempts())
			}
		})
	}
}

func TestCachedAnswerTraceKeepsWinningModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			fmt.Fprint(w, `{"data":{"content":"Fake page"}}`)
			return
		}
		var request struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request.Model == "rejected" {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":{"message":"fake rejection","type":"auth"}}`)
			return
		}
		writeModel(w, "Fake answer")
	}))
	defer server.Close()
	a := traceApp(t)
	cfg := fakeModelConfig(a, server.URL)
	cfg.LLM.Providers[0].Models = append([]config.Model{{ID: "rejected", Name: "rejected"}}, cfg.LLM.Providers[0].Models...)
	cfg.Fetch.Extract.Models = []string{"rejected", "extract_test"}
	a.install(cfg)
	args := fetch.Args{URL: "https://example.test/page", Prompt: "Question"}
	first, err := a.Fetch(context.Background(), Caller{Source: SourceWebUI}, args, Override{})
	if err != nil || first.Error != "" || first.Answer != "Fake answer" {
		t.Fatalf("result=%+v err=%v", first, err)
	}
	trace := core.NewTrace()
	second, err := a.Fetch(core.WithTrace(context.Background(), trace), Caller{Source: SourceWebUI}, args, Override{})
	if err != nil || second.Answer != first.Answer {
		t.Fatalf("result=%+v err=%v", second, err)
	}
	found := false
	for _, n := range trace.Nodes() {
		if n.Kind == "llm" {
			t.Fatal("cached answer called a model")
		}
		if n.Kind == "cache" && n.Name == "answer" {
			found = n.Status == "cached" && n.Attrs["engine"] == "extract_test" && n.Attrs["bytes"] == len(first.Answer)
		}
	}
	if !found {
		t.Fatalf("answer cache=%+v", trace.Nodes())
	}
	if attempts := trace.Attempts(); len(attempts) != 1 || attempts[0].Kind != "fetch" || attempts[0].Status != "cached" {
		t.Fatalf("attempts=%+v", attempts)
	}
}

func TestFailedCallResults(t *testing.T) {
	for _, tool := range []string{"search", "dev_search", "fetch", "research"} {
		t.Run(tool, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "fake upstream failure", http.StatusUnauthorized)
			}))
			defer server.Close()
			a := traceApp(t)
			cfg := fakeModelConfig(a, server.URL)
			cfg.Research.Enabled, cfg.Research.Model = true, "extract_test"
			cfg.Search.Routes = []config.Route{{Provider: "brave", Enabled: true}}
			cfg.DevSearch.Routes = []config.Route{{Provider: "firecrawl", Enabled: true}}
			for _, id := range []string{"brave", "firecrawl"} {
				cfg.Providers[id].BaseURL, cfg.Providers[id].APIKey = server.URL, "fake"
			}
			a.install(cfg)
			trace := core.NewTrace()
			ctx := core.WithTrace(context.Background(), trace)
			caller := Caller{Source: SourceMCP}
			var err error
			switch tool {
			case "search":
				_, err = a.Search(ctx, caller, search.Args{Queries: []string{"fake query"}}, Override{})
			case "dev_search":
				_, err = a.DevSearch(ctx, caller, search.DevArgs{Query: "fake query"}, Override{})
			case "fetch":
				_, err = a.Fetch(ctx, caller, fetch.Args{URL: "https://example.test/page", Raw: true}, Override{})
			case "research":
				_, err = a.Research(ctx, caller, research.Request{Question: "Question"}, Override{}, nil)
				if err == nil {
					t.Fatal("research succeeded")
				}
			}
			if tool != "research" && err != nil {
				t.Fatal(err)
			}
			nodes := trace.Nodes()
			result := nodes[len(nodes)-1]
			if nodes[0].Status != "error" || result.Kind != "result" || result.Parent != 1 || result.Status != "error" || result.Error == "" || result.Error != nodes[0].Error || result.DurationMs != 0 {
				t.Fatalf("root=%+v result=%+v", nodes[0], result)
			}
			if tool == "fetch" && result.Attrs["kind"] != "error" {
				t.Fatalf("fetch result=%+v", result)
			}
		})
	}
}
