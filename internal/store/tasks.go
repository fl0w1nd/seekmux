package store

import (
	"context"
	"database/sql"
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
}

func (s *Store) CreateTask(ctx context.Context, id, question string) error {
	t := now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO research_tasks (id, created_at, updated_at, status, question) VALUES (?, ?, ?, ?, ?)`,
		id, t, t, TaskRunning, question)
	return err
}

func (s *Store) SetTaskProgress(ctx context.Context, id, progress string) {
	_, _ = s.db.ExecContext(ctx, `UPDATE research_tasks SET progress = ?, updated_at = ? WHERE id = ?`, progress, now(), id)
}

func (s *Store) FinishTask(ctx context.Context, id, result string, taskErr error) error {
	status, message := TaskDone, ""
	if taskErr != nil {
		status, message = TaskFailed, taskErr.Error()
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE research_tasks SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?`,
		status, result, message, now(), id)
	return err
}

func (s *Store) GetTask(ctx context.Context, id string) (ResearchTask, bool, error) {
	var t ResearchTask
	err := s.db.QueryRowContext(ctx,
		`SELECT id, created_at, updated_at, status, question, progress, result, error FROM research_tasks WHERE id = ?`, id).
		Scan(&t.ID, &t.CreatedAt, &t.UpdatedAt, &t.Status, &t.Question, &t.Progress, &t.Result, &t.Error)
	if errors.Is(err, sql.ErrNoRows) {
		return ResearchTask{}, false, nil
	}
	return t, err == nil, err
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
