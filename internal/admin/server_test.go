package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/fl0w1nd/seekmux/internal/app"
	"github.com/fl0w1nd/seekmux/internal/research"
	"github.com/fl0w1nd/seekmux/internal/store"
)

func TestAReportIsReadWithoutSigningIn(t *testing.T) {
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
	srv := httptest.NewServer(New(a, "test", fstest.MapFS{}).Handler())
	defer srv.Close()

	get := func(path string) (int, string) {
		t.Helper()
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body strings.Builder
		if err := res.Write(&body); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, body.String()
	}

	for id, status := range map[string]string{"rs_done": store.TaskDone, "rs_failed": store.TaskFailed} {
		if err := st.CreateTask(ctx, id, "the question", app.ResearchBudget{Model: "secret-model"}); err != nil {
			t.Fatal(err)
		}
		st.AddTaskStep(ctx, id, store.TaskStep{Step: 1, Kind: research.EventSearch, Text: "a query"})
		stats := research.Result{Steps: 2, Searches: 2, DevSearches: 1, Fetches: 4, Read: []string{"https://a.example/page"}, Unread: []string{"https://b.example/"}, BudgetExhausted: true}
		report, message := "the report", ""
		if status == store.TaskFailed {
			report, message = "", "upstream said no"
		}
		if err := st.FinishTask(ctx, id, status, report, message, stats); err != nil {
			t.Fatal(err)
		}
	}

	code, body := get("/api/reports/rs_done")
	if code != http.StatusOK {
		t.Fatalf("status %d: %s", code, body)
	}
	var got report
	if err := json.Unmarshal([]byte(body[strings.Index(body, "{"):]), &got); err != nil {
		t.Fatal(err)
	}
	if got.Report != "the report" || got.Question != "the question" || got.Searches != 3 || len(got.Read) != 1 || len(got.Unread) != 1 || !got.CutShort {
		t.Errorf("report = %+v", got)
	}
	// The default retention is 14 days.
	if kept := time.UnixMilli(got.ExpiresAt).Sub(time.UnixMilli(got.CreatedAt)); kept < 13*24*time.Hour || kept > 15*24*time.Hour {
		t.Errorf("the report must expire with the logs, kept for %s", kept)
	}
	for _, private := range []string{"secret-model", "a query", "input_tokens"} {
		if strings.Contains(body, private) {
			t.Errorf("the report gives away %q: %s", private, body)
		}
	}

	if code, body = get("/api/reports/rs_failed"); code != http.StatusOK || strings.Contains(body, "upstream said no") || !strings.Contains(body, `"status":"failed"`) {
		t.Errorf("a failed task says so and not why, got %d: %s", code, body)
	}
	if code, _ = get("/api/reports/rs_none"); code != http.StatusNotFound {
		t.Errorf("an unknown report = %d", code)
	}
	// The task itself stays behind the session.
	if code, _ = get("/api/research/tasks/rs_done"); code != http.StatusUnauthorized {
		t.Errorf("the task without a session = %d", code)
	}
}

func TestTheWebManifestIsServedWithItsOwnType(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, err := app.New(context.Background(), st)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	assets := fstest.MapFS{
		"index.html":           {Data: []byte("<html></html>")},
		"manifest.webmanifest": {Data: []byte(`{"name":"SeekMux"}`)},
	}
	srv := httptest.NewServer(New(a, "test", assets).Handler())
	defer srv.Close()

	res, err := http.Get(srv.URL + "/manifest.webmanifest")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if got := res.Header.Get("Content-Type"); !strings.HasPrefix(got, "application/manifest+json") {
		t.Errorf("Content-Type = %q", got)
	}
}
