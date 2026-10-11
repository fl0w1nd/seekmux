package mcpsrv

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/fl0w1nd/seekmux/internal/app"
	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/research"
	"github.com/fl0w1nd/seekmux/internal/store"
)

type withKey struct{ secret string }

func (k withKey) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+k.secret)
	return http.DefaultTransport.RoundTrip(r)
}

func TestResearchResultWaitsAndReportsTheBudget(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, err := app.New(ctx, st)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	cfg := config.Default()
	cfg.LLM.Providers = []config.LLMProvider{{ID: "p", Type: config.LLMAnthropic, Models: []config.Model{{ID: "m", Name: "x"}}}}
	cfg.Research.Enabled, cfg.Research.Model, cfg.Research.ResultWaitSeconds = true, "m", 1
	if err := a.SaveConfig(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	_, secret, err := st.CreateAPIKey(ctx, "test", []string{config.ToolResearch}, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateTask(ctx, "rs_test", "question", app.ResearchBudget{MaxSteps: 24, MaxDurationSeconds: 420}); err != nil {
		t.Fatal(err)
	}
	st.AddTaskStep(ctx, "rs_test", store.TaskStep{Step: 3, Kind: research.EventSearch, Line: "search: something"})
	st.SetTaskSpent(ctx, "rs_test", research.Spent{Steps: 3}, "")

	srv := httptest.NewServer(Handler(a, "test"))
	defer srv.Close()

	var mu sync.Mutex
	var lines []string
	client := mcp.NewClient(&mcp.Implementation{Name: "test"}, &mcp.ClientOptions{
		ProgressNotificationHandler: func(_ context.Context, req *mcp.ProgressNotificationClientRequest) {
			mu.Lock()
			defer mu.Unlock()
			lines = append(lines, req.Params.Message)
		},
	})
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: srv.URL, HTTPClient: &http.Client{Transport: withKey{secret}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	call := func() string {
		t.Helper()
		params := &mcp.CallToolParams{Name: "research_result", Arguments: map[string]any{"task_id": "rs_test"}}
		params.SetProgressToken("p")
		result, err := session.CallTool(ctx, params)
		if err != nil {
			t.Fatal(err)
		}
		return result.Content[0].(*mcp.TextContent).Text
	}

	got := call()
	for _, want := range []string{`"status":"running"`, `"progress":"search: something"`, "of at most 7m0s", `"steps":"3 of at most 24"`} {
		if !strings.Contains(got, want) {
			t.Errorf("running answer lacks %s: %s", want, got)
		}
	}
	mu.Lock()
	if len(lines) == 0 || lines[0] != "search: something" {
		t.Errorf("progress notifications = %q", lines)
	}
	mu.Unlock()

	if err := st.FinishTask(ctx, "rs_test", store.TaskDone, "the report", "", nil); err != nil {
		t.Fatal(err)
	}
	if got := call(); got != "the report" {
		t.Errorf("finished answer = %q", got)
	}

	for id, want := range map[string]string{"rs_test": "the task is not running: it ended as done", "rs_none": "unknown task_id"} {
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "research_cancel", Arguments: map[string]any{"task_id": id}})
		if err != nil {
			t.Fatal(err)
		}
		if got := result.Content[0].(*mcp.TextContent).Text; !result.IsError || !strings.Contains(got, want) {
			t.Errorf("cancel %s = %q", id, got)
		}
	}
}
