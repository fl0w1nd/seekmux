package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

const (
	TaskRunning = "running"
	TaskDone    = "done"
	TaskFailed  = "failed"
	// TaskCanceled is a run stopped from the console.
	TaskCanceled = "canceled"
)

// ResearchTask is a research run started without waiting for its result.
type ResearchTask struct {
	ID        string `json:"id"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	Status    string `json:"status"`
	Question  string `json:"question"`
	Progress  string `json:"progress,omitempty"`
	Result    string `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
	// Steps holds what the agent did, each as {"at": ms since created_at,
	// "step", "kind", "text"}. A task written before steps had a kind holds
	// {"at", "line"} instead.
	Steps json.RawMessage `json:"steps,omitempty"`
	// Stats is what FinishTask stored for a finished run, if anything.
	Stats json.RawMessage `json:"stats,omitempty"`
	// Budget is what the run was started with and Spent what it has used of
	// that, both as the caller stored them.
	Budget json.RawMessage `json:"budget,omitempty"`
	Spent  json.RawMessage `json:"spent,omitempty"`
	// Draft is the text the model is writing in its current step.
	Draft string `json:"draft,omitempty"`
}

// TaskStep is one thing a research agent did.
type TaskStep struct {
	// Step is the model round it belongs to, from 1.
	Step int
	Kind string
	Text string
	// Line words the step for a caller that polls the task; an empty one
	// leaves the progress as it is.
	Line string
}

// maxTaskSteps bounds the progress history kept for one task.
const maxTaskSteps = 500

// encode returns v as JSON, or "" for nil.
func encode(v any) (string, error) {
	if v == nil {
		return "", nil
	}
	b, err := json.Marshal(v)
	return string(b), err
}

// CreateTask adds a running task; budget, when not nil, is stored as JSON.
func (s *Store) CreateTask(ctx context.Context, id, question string, budget any) error {
	encoded, err := encode(budget)
	if err != nil {
		return err
	}
	t := now()
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO research_tasks (id, created_at, updated_at, status, question, budget) VALUES (?, ?, ?, ?, ?, ?)`,
		id, t, t, TaskRunning, question, encoded)
	return err
}

// AddTaskStep appends step to the steps and makes its line, if it has one,
// the progress.
func (s *Store) AddTaskStep(ctx context.Context, id string, step TaskStep) {
	t := now()
	_, _ = s.db.ExecContext(ctx,
		`UPDATE research_tasks SET progress = CASE WHEN ? = '' THEN progress ELSE ? END, updated_at = ?,
			steps = CASE WHEN json_array_length(steps) < ?
				THEN json_insert(steps, '$[#]', json_object('at', ? - created_at, 'step', ?, 'kind', ?, 'text', ?))
				ELSE steps END
		WHERE id = ? AND status = ?`,
		step.Line, step.Line, t, maxTaskSteps, t, step.Step, step.Kind, step.Text, id, TaskRunning)
}

// SetTaskSpent records how much of its budget a running task has used, as
// JSON, and the text its model is writing.
func (s *Store) SetTaskSpent(ctx context.Context, id string, spent any, draft string) {
	encoded, err := encode(spent)
	if err != nil {
		return
	}
	_, _ = s.db.ExecContext(ctx,
		`UPDATE research_tasks SET spent = ?, draft = ?, updated_at = ? WHERE id = ? AND status = ?`,
		encoded, draft, now(), id, TaskRunning)
}

// FinishTask records the outcome under status, with message as the error of
// a run that did not finish; stats, when not nil, is stored as JSON.
func (s *Store) FinishTask(ctx context.Context, id, status, result, message string, stats any) error {
	encoded, err := encode(stats)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE research_tasks SET status = ?, result = ?, error = ?, stats = ?, updated_at = ?,
			draft = CASE WHEN ? = '' THEN draft ELSE '' END
		WHERE id = ?`,
		status, result, message, encoded, now(), result, id)
	return err
}

const taskColumns = `id, created_at, updated_at, status, question, progress, error, stats, budget, spent`

func raw(text string) json.RawMessage {
	if text == "" {
		return nil
	}
	return json.RawMessage(text)
}

func (s *Store) GetTask(ctx context.Context, id string) (ResearchTask, bool, error) {
	var t ResearchTask
	var steps, stats, budget, spent string
	err := s.db.QueryRowContext(ctx, `SELECT `+taskColumns+`, result, steps, draft FROM research_tasks WHERE id = ?`, id).
		Scan(&t.ID, &t.CreatedAt, &t.UpdatedAt, &t.Status, &t.Question, &t.Progress, &t.Error, &stats, &budget, &spent, &t.Result, &steps, &t.Draft)
	if errors.Is(err, sql.ErrNoRows) {
		return ResearchTask{}, false, nil
	}
	if err != nil {
		return ResearchTask{}, false, err
	}
	t.Steps, t.Stats, t.Budget, t.Spent = json.RawMessage(steps), raw(stats), raw(budget), raw(spent)
	return t, true, nil
}

// ListTasks returns the latest tasks, newest first, without their reports,
// steps and drafts.
func (s *Store) ListTasks(ctx context.Context, limit int) ([]ResearchTask, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+taskColumns+` FROM research_tasks ORDER BY created_at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []ResearchTask{}
	for rows.Next() {
		var t ResearchTask
		var stats, budget, spent string
		if err := rows.Scan(&t.ID, &t.CreatedAt, &t.UpdatedAt, &t.Status, &t.Question, &t.Progress, &t.Error, &stats, &budget, &spent); err != nil {
			return nil, err
		}
		t.Stats, t.Budget, t.Spent = raw(stats), raw(budget), raw(spent)
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}

// RecoverTasks fails the tasks a previous process left running and drops
// tasks older than a week.
func (s *Store) RecoverTasks(ctx context.Context) {
	_, _ = s.db.ExecContext(ctx,
		`UPDATE research_tasks SET status = ?, error = 'the server restarted while this task was running', updated_at = ? WHERE status = ?`,
		TaskFailed, now(), TaskRunning)
	s.pruneTasks(ctx)
}

func (s *Store) pruneTasks(ctx context.Context) {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM research_tasks WHERE created_at < ?`, time.Now().AddDate(0, 0, -7).UnixMilli())
}
