package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

type step struct {
	At   int64  `json:"at"`
	Line string `json:"line"`
}

func steps(t *testing.T, task ResearchTask) []step {
	t.Helper()
	var out []step
	if err := json.Unmarshal(task.Steps, &out); err != nil {
		t.Fatalf("steps %s: %v", task.Steps, err)
	}
	return out
}

func TestTaskKeepsEveryProgressLine(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	if err := s.CreateTask(ctx, "rs_1", "q"); err != nil {
		t.Fatal(err)
	}
	task, _, _ := s.GetTask(ctx, "rs_1")
	if got := steps(t, task); len(got) != 0 {
		t.Fatalf("a new task has no steps, got %+v", got)
	}

	s.SetTaskProgress(ctx, "rs_1", "searching")
	s.SetTaskProgress(ctx, "rs_1", "reading")
	task, _, _ = s.GetTask(ctx, "rs_1")
	got := steps(t, task)
	if task.Progress != "reading" || len(got) != 2 || got[0].Line != "searching" || got[1].Line != "reading" {
		t.Fatalf("progress %q, steps %+v", task.Progress, got)
	}
	if got[0].At < 0 || got[1].At < got[0].At {
		t.Fatalf("steps are timed from the start, got %+v", got)
	}

	for range maxTaskSteps {
		s.SetTaskProgress(ctx, "rs_1", "more")
	}
	task, _, _ = s.GetTask(ctx, "rs_1")
	if n := len(steps(t, task)); n != maxTaskSteps {
		t.Fatalf("steps are capped at %d, got %d", maxTaskSteps, n)
	}

	if task.Stats != nil {
		t.Fatalf("a running task has no stats, got %s", task.Stats)
	}
	if err := s.FinishTask(ctx, "rs_1", "report", map[string]int{"searches": 3}, nil); err != nil {
		t.Fatal(err)
	}
	task, _, _ = s.GetTask(ctx, "rs_1")
	if task.Status != TaskDone || string(task.Stats) != `{"searches":3}` {
		t.Fatalf("status %q, stats %s", task.Status, task.Stats)
	}

	if err := s.CreateTask(ctx, "rs_2", "q"); err != nil {
		t.Fatal(err)
	}
	if err := s.FinishTask(ctx, "rs_2", "", nil, errors.New("boom")); err != nil {
		t.Fatal(err)
	}
	task, _, _ = s.GetTask(ctx, "rs_2")
	if task.Status != TaskFailed || task.Stats != nil {
		t.Fatalf("status %q, stats %s", task.Status, task.Stats)
	}
}

func TestOpenAddsTaskHistoryToAnOldDatabase(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "seekmux.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE research_tasks (
		id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		status TEXT NOT NULL, question TEXT NOT NULL,
		progress TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '');
		INSERT INTO research_tasks (id, created_at, updated_at, status, question) VALUES ('rs_old', 1, 1, 'done', 'q')`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}

	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, ok, err := s.GetTask(context.Background(), "rs_old")
	if err != nil || !ok {
		t.Fatalf("ok %v, err %v", ok, err)
	}
	if got := steps(t, task); len(got) != 0 || task.Stats != nil {
		t.Fatalf("an old task reads as having no history, got %+v %s", got, task.Stats)
	}
}
