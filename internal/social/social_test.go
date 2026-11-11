package social

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/worker"
)

// fakeWorkers answers searches as the test sets for each worker.
type fakeWorkers struct {
	mu      sync.Mutex
	online  map[string]bool
	answers map[string]func(worker.SearchRequest) ([]worker.Post, error)
	asked   []string
}

func (f *fakeWorkers) Online(id string) bool { return f.online[id] }

func (f *fakeWorkers) Search(_ context.Context, id string, req worker.SearchRequest) ([]worker.Post, error) {
	f.mu.Lock()
	f.asked = append(f.asked, id)
	f.mu.Unlock()
	answer := f.answers[id]
	if answer == nil {
		return nil, worker.ErrOffline
	}
	return answer(req)
}

func xConfig(t *testing.T) *config.Config {
	t.Helper()
	var c config.Config
	doc := `{"fetchers": [{"id": "home", "type": "opencli", "name": "Home", "workers": [
		{"id": "w1", "name": "Laptop", "enabled": true, "token": "t1"},
		{"id": "w2", "name": "Desktop", "enabled": true, "token": "t2"}]}],
		"social": {"sources": [{"platform": "x", "enabled": true, "fetcher": "home", "workers": ["w1", "w2"]}]}}`
	if err := json.Unmarshal([]byte(doc), &c); err != nil {
		t.Fatal(err)
	}
	c.Normalize()
	return &c
}

func run(t *testing.T, cfg *config.Config, w Workers, args XArgs) XResult {
	t.Helper()
	if err := args.Validate(cfg); err != nil {
		t.Fatal(err)
	}
	return RunX(context.Background(), cfg, core.NewLimits(), w, args)
}

func TestValidateAppliesDefaults(t *testing.T) {
	cfg := xConfig(t)
	args := XArgs{Query: "  mcp  "}
	if err := args.Validate(cfg); err != nil || args.Query != "mcp" || args.Sort != SortTop || args.MaxResults != DefaultMaxResults {
		t.Fatalf("args = %+v, err = %v", args, err)
	}
	for _, bad := range []XArgs{{}, {Query: "q", Sort: "best"}, {Query: "q", MaxResults: 51}, {Query: "q", TimeRange: "hour"}} {
		if err := bad.Validate(cfg); err == nil {
			t.Fatalf("%+v must be refused", bad)
		}
	}
	cfg.Social.Sources[0].Enabled = false
	if err := (&XArgs{Query: "q"}).Validate(cfg); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("err = %v", err)
	}
}

func TestTimeRangeBecomesSince(t *testing.T) {
	now := time.Date(2026, 11, 12, 1, 0, 0, 0, time.UTC)
	for timeRange, want := range map[string]string{"": "mcp", "day": "mcp since:2026-11-11", "week": "mcp since:2026-11-05", "month": "mcp since:2026-10-12", "year": "mcp since:2025-11-12"} {
		if got := (XArgs{Query: "mcp", TimeRange: timeRange}).query(now); got != want {
			t.Errorf("%q: %q, want %q", timeRange, got, want)
		}
	}
}

func TestRunXSaysTheFetcherIsOffline(t *testing.T) {
	w := &fakeWorkers{online: map[string]bool{}}
	got := run(t, xConfig(t), w, XArgs{Query: "mcp"})
	if !strings.Contains(got.Error, "X search is unavailable") || !strings.Contains(got.Error, `"Home" is offline`) || len(w.asked) != 0 {
		t.Fatalf("result = %+v, asked = %v", got, w.asked)
	}
	if got.Posts == nil {
		t.Fatal("posts must be an empty list, not null")
	}
}

func TestRunXMovesPastAnOutdatedWorker(t *testing.T) {
	w := &fakeWorkers{
		online: map[string]bool{"w1": true, "w2": true},
		answers: map[string]func(worker.SearchRequest) ([]worker.Post, error){
			"w1": func(worker.SearchRequest) ([]worker.Post, error) {
				return nil, &worker.Error{Code: worker.CodeOutdated, Message: "the worker (version 0.0.3) cannot do x_search"}
			},
			"w2": func(req worker.SearchRequest) ([]worker.Post, error) {
				if req.Site != "x" || req.Feature != worker.FeatureXSearch || req.Sort != SortLatest || req.Limit != 3 || req.Query != "mcp" {
					t.Errorf("request = %+v", req)
				}
				return []worker.Post{{ID: "1", Author: "a", Text: "hi"}}, nil
			},
		},
	}
	got := run(t, xConfig(t), w, XArgs{Query: "mcp", Sort: SortLatest, MaxResults: 3})
	if got.Error != "" || len(got.Posts) != 1 || got.Fetcher != "home" || strings.Join(w.asked, ",") != "w1,w2" {
		t.Fatalf("result = %+v, asked = %v", got, w.asked)
	}
}

func TestRunXStopsAtARefusal(t *testing.T) {
	w := &fakeWorkers{
		online: map[string]bool{"w1": true, "w2": true},
		answers: map[string]func(worker.SearchRequest) ([]worker.Post, error){
			"w1": func(worker.SearchRequest) ([]worker.Post, error) {
				return nil, &worker.Error{Code: worker.CodeLoginRequired, Message: "Not logged in to x.com"}
			},
		},
	}
	got := run(t, xConfig(t), w, XArgs{Query: "mcp"})
	if !strings.Contains(got.Error, "not signed in to X: Not logged in to x.com") || strings.Join(w.asked, ",") != "w1" {
		t.Fatalf("result = %+v, asked = %v", got, w.asked)
	}
}

func TestRunXReportsEveryWorkerThatCouldNot(t *testing.T) {
	w := &fakeWorkers{
		online: map[string]bool{"w1": true},
		answers: map[string]func(worker.SearchRequest) ([]worker.Post, error){
			"w1": func(worker.SearchRequest) ([]worker.Post, error) {
				return nil, &worker.Error{Code: worker.CodeBusy, Message: "the worker is already running 1 requests"}
			},
		},
	}
	got := run(t, xConfig(t), w, XArgs{Query: "mcp"})
	if !strings.Contains(got.Error, `X search is unavailable: no worker of the fetcher "Home" could take it`) || !strings.Contains(got.Error, "Laptop: busy") || !strings.Contains(got.Error, "Desktop: the worker is not connected") {
		t.Fatalf("result = %+v", got)
	}
}
