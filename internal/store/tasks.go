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
	// Steps holds every progress line as {"at": ms since created_at, "line"}.
	Steps json.RawMessage `json:"steps"`
	// Stats is what FinishTask stored for a finished run, if anything.
	Stats json.RawMessage `json:"stats,omitempty"`
}

// maxTaskSteps bounds the progress history kept for one task.
const maxTaskSteps = 500

func (s *Store) CreateTask(ctx context.Context, id, question string) error {
	t := now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO research_tasks (id, created_at, updated_at, status, question) VALUES (?, ?, ?, ?, ?)`,
		id, t, t, TaskRunning, question)
	return err
}

// SetTaskProgress sets the latest progress line and appends it to the steps.
func (s *Store) SetTaskProgress(ctx context.Context, id, progress string) {
	t := now()
	_, _ = s.db.ExecContext(ctx,
		`UPDATE research_tasks SET progress = ?, updated_at = ?,
			steps = CASE WHEN json_array_length(steps) < ?
				THEN json_insert(steps, '$[#]', json_object('at', ? - created_at, 'line', ?))
				ELSE steps END
		WHERE id = ?`,
		progress, t, maxTaskSteps, t, progress, id)
}

// FinishTask records the outcome; stats, when not nil, is stored as JSON.
func (s *Store) FinishTask(ctx context.Context, id, result string, stats any, taskErr error) error {
	status, message := TaskDone, ""
	if taskErr != nil {
		status, message = TaskFailed, taskErr.Error()
	}
	encoded := ""
	if stats != nil {
		b, err := json.Marshal(stats)
		if err != nil {
			return err
		}
		encoded = string(b)
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE research_tasks SET status = ?, result = ?, error = ?, stats = ?, updated_at = ? WHERE id = ?`,
		status, result, message, encoded, now(), id)
	return err
}

func (s *Store) GetTask(ctx context.Context, id string) (ResearchTask, bool, error) {
	var t ResearchTask
	var steps, stats string
	err := s.db.QueryRowContext(ctx,
		`SELECT id, created_at, updated_at, status, question, progress, result, error, steps, stats FROM research_tasks WHERE id = ?`, id).
		Scan(&t.ID, &t.CreatedAt, &t.UpdatedAt, &t.Status, &t.Question, &t.Progress, &t.Result, &t.Error, &steps, &stats)
	if errors.Is(err, sql.ErrNoRows) {
		return ResearchTask{}, false, nil
	}
	if err != nil {
		return ResearchTask{}, false, err
	}
	t.Steps = json.RawMessage(steps)
	if stats != "" {
		t.Stats = json.RawMessage(stats)
	}
	return t, true, nil
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
