package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
)

type step struct {
	At   int64  `json:"at"`
	Step int    `json:"step"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

func steps(t *testing.T, task ResearchTask) []step {
	t.Helper()
	var out []step
	if err := json.Unmarshal(task.Steps, &out); err != nil {
		t.Fatalf("steps %s: %v", task.Steps, err)
	}
	return out
}

func TestTaskKeepsEveryStep(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	if err := s.CreateTask(ctx, "rs_1", "q", map[string]int{"max_steps": 4}); err != nil {
		t.Fatal(err)
	}
	task, _, _ := s.GetTask(ctx, "rs_1")
	if got := steps(t, task); len(got) != 0 || string(task.Budget) != `{"max_steps":4}` || task.Spent != nil {
		t.Fatalf("a new task has its budget and nothing else, got %+v %s %s", got, task.Budget, task.Spent)
	}

	s.AddTaskStep(ctx, "rs_1", TaskStep{Step: 1, Kind: "search", Text: "a | b", Line: "search: a | b"})
	s.AddTaskStep(ctx, "rs_1", TaskStep{Step: 2, Kind: "note", Text: "thinking"})
	s.SetTaskSpent(ctx, "rs_1", map[string]int{"steps": 2}, "draft")
	task, _, _ = s.GetTask(ctx, "rs_1")
	got := steps(t, task)
	if len(got) != 2 || got[0] != (step{At: got[0].At, Step: 1, Kind: "search", Text: "a | b"}) || got[1].Kind != "note" || got[1].Step != 2 {
		t.Fatalf("steps %+v", got)
	}
	if task.Progress != "search: a | b" {
		t.Fatalf("a step without a line must leave the progress, got %q", task.Progress)
	}
	if got[0].At < 0 || got[1].At < got[0].At {
		t.Fatalf("steps are timed from the start, got %+v", got)
	}
	if string(task.Spent) != `{"steps":2}` || task.Draft != "draft" {
		t.Fatalf("spent %s, draft %q", task.Spent, task.Draft)
	}

	for range maxTaskSteps {
		s.AddTaskStep(ctx, "rs_1", TaskStep{Kind: "fetch", Text: "more", Line: "fetch: more"})
	}
	task, _, _ = s.GetTask(ctx, "rs_1")
	if n := len(steps(t, task)); n != maxTaskSteps {
		t.Fatalf("steps are capped at %d, got %d", maxTaskSteps, n)
	}

	if task.Stats != nil {
		t.Fatalf("a running task has no stats, got %s", task.Stats)
	}
	if err := s.FinishTask(ctx, "rs_1", TaskDone, "report", "", map[string]int{"searches": 3}); err != nil {
		t.Fatal(err)
	}
	s.AddTaskStep(ctx, "rs_1", TaskStep{Kind: "fetch", Text: "late", Line: "fetch: late"})
	s.SetTaskSpent(ctx, "rs_1", map[string]int{"steps": 9}, "late")
	task, _, _ = s.GetTask(ctx, "rs_1")
	if task.Status != TaskDone || string(task.Stats) != `{"searches":3}` || task.Draft != "" {
		t.Fatalf("status %q, stats %s, draft %q", task.Status, task.Stats, task.Draft)
	}
	if task.Progress != "fetch: more" || string(task.Spent) != `{"steps":2}` {
		t.Fatalf("a finished task must not change, got progress %q, spent %s", task.Progress, task.Spent)
	}

	if err := s.CreateTask(ctx, "rs_2", "q", nil); err != nil {
		t.Fatal(err)
	}
	s.SetTaskSpent(ctx, "rs_2", nil, "half a report")
	if err := s.FinishTask(ctx, "rs_2", TaskCanceled, "", "stopped", nil); err != nil {
		t.Fatal(err)
	}
	task, _, _ = s.GetTask(ctx, "rs_2")
	if task.Status != TaskCanceled || task.Error != "stopped" || task.Stats != nil || task.Budget != nil {
		t.Fatalf("status %q, error %q, stats %s, budget %s", task.Status, task.Error, task.Stats, task.Budget)
	}
	if task.Draft != "half a report" {
		t.Fatalf("a run without a report keeps what was written, got %q", task.Draft)
	}

	list, err := s.ListTasks(ctx, 10)
	if err != nil || len(list) != 2 {
		t.Fatalf("list %+v, err %v", list, err)
	}
	for _, task := range list {
		if task.Result != "" || task.Steps != nil || task.Draft != "" {
			t.Fatalf("the list carries no report, steps or draft, got %+v", task)
		}
	}
	if list, _ = s.ListTasks(ctx, 1); len(list) != 1 {
		t.Fatalf("limit 1 returned %d tasks", len(list))
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
	if got := steps(t, task); len(got) != 0 || task.Stats != nil || task.Budget != nil || task.Spent != nil || task.Draft != "" {
		t.Fatalf("an old task reads as having no history, got %+v", task)
	}
}
