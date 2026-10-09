package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/fl0w1nd/seekmux/internal/core"
)

// LogEntry is one served tool call.
type LogEntry struct {
	ID         int64  `json:"id"`
	TS         int64  `json:"ts"`
	Tool       string `json:"tool"`
	Source     string `json:"source"`
	APIKeyID   int64  `json:"api_key_id,omitempty"`
	APIKeyName string `json:"api_key_name,omitempty"`
	Status     string `json:"status"`
	DurationMs int64  `json:"duration_ms"`
	// Provider is the provider that produced the answer, when there is one.
	Provider string `json:"provider,omitempty"`
	// Summary is the query or URL shown in the list.
	Summary string `json:"summary"`
	Error   string `json:"error,omitempty"`
	core.Usage
	Attempts json.RawMessage `json:"attempts,omitempty"`
	// Hops is set on listed entries whose call did not go straight through:
	// the providers and models it passed, in order.
	Hops []Hop `json:"hops,omitempty"`
	// Request and Response are only loaded for a single entry.
	Request  string `json:"request,omitempty"`
	Response string `json:"response,omitempty"`
}

const (
	StatusOK    = "ok"
	StatusError = "error"
)

// LogWriter batches log inserts on one goroutine so tool calls never wait on
// the disk, and fans new entries out to live subscribers.
type LogWriter struct {
	store *Store
	queue chan LogEntry
	done  chan struct{}

	mu   sync.Mutex
	subs map[chan LogEntry]struct{}

	// closing guards queue against a call that outlives the shutdown.
	closing sync.RWMutex
	closed  bool
}

func (s *Store) NewLogWriter() *LogWriter {
	w := &LogWriter{store: s, queue: make(chan LogEntry, 512), done: make(chan struct{}), subs: map[chan LogEntry]struct{}{}}
	go w.run()
	return w
}

// Write queues an entry. Under a burst that outruns the disk the entry is dropped.
func (w *LogWriter) Write(entry LogEntry) {
	w.closing.RLock()
	defer w.closing.RUnlock()
	if w.closed {
		return
	}
	select {
	case w.queue <- entry:
	default:
	}
}

// Close flushes the queue.
func (w *LogWriter) Close() {
	w.closing.Lock()
	w.closed = true
	close(w.queue)
	w.closing.Unlock()
	<-w.done
}

// Subscribe returns a channel of entries as they are stored. Slow subscribers
// miss entries rather than block the writer.
func (w *LogWriter) Subscribe() (<-chan LogEntry, func()) {
	ch := make(chan LogEntry, 64)
	w.mu.Lock()
	w.subs[ch] = struct{}{}
	w.mu.Unlock()
	return ch, func() {
		w.mu.Lock()
		delete(w.subs, ch)
		w.mu.Unlock()
	}
}

func (w *LogWriter) run() {
	defer close(w.done)
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	var batch []LogEntry
	flush := func() {
		if len(batch) == 0 {
			return
		}
		stored := w.store.insertLogs(batch)
		batch = batch[:0]
		w.mu.Lock()
		for _, entry := range stored {
			entry.Request, entry.Response = "", ""
			for ch := range w.subs {
				select {
				case ch <- entry:
				default:
				}
			}
		}
		w.mu.Unlock()
	}
	for {
		select {
		case entry, ok := <-w.queue:
			if !ok {
				flush()
				return
			}
			batch = append(batch, entry)
			if len(batch) >= 64 {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func (s *Store) insertLogs(batch []LogEntry) []LogEntry {
	tx, err := s.db.Begin()
	if err != nil {
		return nil
	}
	stored := make([]LogEntry, 0, len(batch))
	for _, e := range batch {
		attempts := string(e.Attempts)
		if attempts == "" {
			attempts = "[]"
		}
		res, err := tx.Exec(`INSERT INTO request_logs
			(ts, tool, source, api_key_id, api_key_name, status, duration_ms, provider, summary, request, response, error, attempts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			e.TS, e.Tool, e.Source, e.APIKeyID, e.APIKeyName, e.Status, e.DurationMs, e.Provider, e.Summary,
			e.Request, e.Response, e.Error, attempts, e.InputTokens, e.OutputTokens, e.CacheReadTokens, e.CacheWriteTokens)
		if err != nil {
			continue
		}
		e.ID, _ = res.LastInsertId()
		stored = append(stored, e)
	}
	if err := tx.Commit(); err != nil {
		return nil
	}
	return stored
}

// LogFilter narrows ListLogs. Before pages backwards from a log id.
type LogFilter struct {
	Tool, Status, Provider, Source, Query string
	// Fallback keeps only calls in which a provider or model failed or was skipped.
	Fallback bool
	Before   int64
	Limit    int
}

// Hop is one stop of a call's way through providers or models. Count is the
// number of consecutive attempts that ended the same way.
type Hop struct {
	Kind     string `json:"kind"`
	Provider string `json:"provider"`
	Status   string `json:"status"`
	Count    int    `json:"count"`
}

// hops condenses a call's attempts into its route, or returns nil when every
// attempt worked first time and there is nothing to tell.
func hops(attempts string) []Hop {
	var list []Hop
	if json.Unmarshal([]byte(attempts), &list) != nil {
		return nil
	}
	var out []Hop
	detour := false
	for _, a := range list {
		if a.Status == "cached" {
			continue
		}
		detour = detour || a.Status == "error" || a.Status == "skipped"
		if n := len(out); n > 0 && out[n-1].Kind == a.Kind && out[n-1].Provider == a.Provider && out[n-1].Status == a.Status {
			out[n-1].Count++
			continue
		}
		a.Count = 1
		out = append(out, a)
	}
	if !detour {
		return nil
	}
	return out
}

const logListColumns = `id, ts, tool, source, api_key_id, api_key_name, status, duration_ms, provider, summary, error, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens`

func (s *Store) ListLogs(ctx context.Context, f LogFilter) ([]LogEntry, error) {
	var where []string
	var args []any
	add := func(clause string, value any) {
		where = append(where, clause)
		args = append(args, value)
	}
	if f.Tool != "" {
		add("tool = ?", f.Tool)
	}
	if f.Status != "" {
		add("status = ?", f.Status)
	}
	if f.Source != "" {
		add("source = ?", f.Source)
	}
	if f.Provider != "" {
		// Match the winning provider as well as any provider that was tried.
		where = append(where, `(provider = ? OR EXISTS (SELECT 1 FROM json_each(request_logs.attempts) a WHERE json_extract(a.value, '$.provider') = ?))`)
		args = append(args, f.Provider, f.Provider)
	}
	if f.Query != "" {
		pattern := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(f.Query) + "%"
		where = append(where, `(summary LIKE ? ESCAPE '\' OR error LIKE ? ESCAPE '\')`)
		args = append(args, pattern, pattern)
	}
	if f.Fallback {
		where = append(where, `EXISTS (SELECT 1 FROM json_each(request_logs.attempts) a WHERE json_extract(a.value, '$.status') IN ('error', 'skipped'))`)
	}
	if f.Before > 0 {
		add("id < ?", f.Before)
	}
	query := `SELECT ` + logListColumns + `, attempts FROM request_logs`
	if len(where) > 0 {
		query += ` WHERE ` + strings.Join(where, " AND ")
	}
	limit := f.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []LogEntry{}
	for rows.Next() {
		var e LogEntry
		var attempts string
		if err := rows.Scan(&e.ID, &e.TS, &e.Tool, &e.Source, &e.APIKeyID, &e.APIKeyName, &e.Status, &e.DurationMs,
			&e.Provider, &e.Summary, &e.Error, &e.InputTokens, &e.OutputTokens, &e.CacheReadTokens, &e.CacheWriteTokens, &attempts); err != nil {
			return nil, err
		}
		// A research run makes dozens of calls of its own; its route is in the detail view.
		if e.Tool != "research" {
			e.Hops = hops(attempts)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

func (s *Store) GetLog(ctx context.Context, id int64) (LogEntry, bool, error) {
	var e LogEntry
	var attempts string
	err := s.db.QueryRowContext(ctx, `SELECT `+logListColumns+`, attempts, request, response FROM request_logs WHERE id = ?`, id).
		Scan(&e.ID, &e.TS, &e.Tool, &e.Source, &e.APIKeyID, &e.APIKeyName, &e.Status, &e.DurationMs,
			&e.Provider, &e.Summary, &e.Error, &e.InputTokens, &e.OutputTokens, &e.CacheReadTokens, &e.CacheWriteTokens, &attempts, &e.Request, &e.Response)
	if errors.Is(err, sql.ErrNoRows) {
		return LogEntry{}, false, nil
	}
	e.Attempts = json.RawMessage(attempts)
	return e, err == nil, err
}

func (s *Store) ClearLogs(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM request_logs`)
	return err
}

// Prune applies the log retention and drops expired sessions.
func (s *Store) Prune(ctx context.Context, retentionDays, maxRows int) {
	cutoff := time.Now().AddDate(0, 0, -retentionDays).UnixMilli()
	_, _ = s.db.ExecContext(ctx, `DELETE FROM request_logs WHERE ts < ?`, cutoff)
	_, _ = s.db.ExecContext(ctx,
		`DELETE FROM request_logs WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM request_logs) - ?`, maxRows)
	s.pruneSessions(ctx)
	s.pruneTasks(ctx)
}

// ToolStats summarizes the calls of one tool.
type ToolStats struct {
	Tool   string `json:"tool"`
	Calls  int    `json:"calls"`
	Errors int    `json:"errors"`
	P50Ms  int64  `json:"p50_ms"`
	P95Ms  int64  `json:"p95_ms"`
}

// ProviderStats summarizes the upstream attempts against one provider for one kind of call.
type ProviderStats struct {
	Kind     string `json:"kind"`
	Provider string `json:"provider"`
	Calls    int    `json:"calls"`
	Errors   int    `json:"errors"`
	Canceled int    `json:"canceled"`
	// Wins counts the tool calls this provider answered.
	Wins  int   `json:"wins"`
	P50Ms int64 `json:"p50_ms"`
	P95Ms int64 `json:"p95_ms"`
}

// Bucket is the call volume of one time slice.
type Bucket struct {
	TS     int64 `json:"ts"`
	Calls  int   `json:"calls"`
	Errors int   `json:"errors"`
}

type Stats struct {
	Since     int64           `json:"since"`
	Tools     []ToolStats     `json:"tools"`
	Providers []ProviderStats `json:"providers"`
	Buckets   []Bucket        `json:"buckets"`
	core.Usage
}

func percentile(sorted []int64, p float64) int64 {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[min(len(sorted)-1, int(float64(len(sorted))*p))]
}

// Stats aggregates the logs of the last window into buckets of the given size.
func (s *Store) Stats(ctx context.Context, window, bucket time.Duration) (Stats, error) {
	since := time.Now().Add(-window).UnixMilli()
	stats := Stats{Since: since, Tools: []ToolStats{}, Providers: []ProviderStats{}, Buckets: []Bucket{}}

	rows, err := s.db.QueryContext(ctx,
		`SELECT ts, tool, status, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM request_logs WHERE ts >= ? ORDER BY ts`, since)
	if err != nil {
		return stats, err
	}
	defer rows.Close()

	size := bucket.Milliseconds()
	first := since / size * size
	count := int((time.Now().UnixMilli()-first)/size) + 1
	stats.Buckets = make([]Bucket, count)
	for i := range stats.Buckets {
		stats.Buckets[i].TS = first + int64(i)*size
	}
	tools := map[string]*ToolStats{}
	toolDurations := map[string][]int64{}
	for rows.Next() {
		var ts, duration int64
		var tool, status string
		var usage core.Usage
		if err := rows.Scan(&ts, &tool, &status, &duration, &usage.InputTokens, &usage.OutputTokens, &usage.CacheReadTokens, &usage.CacheWriteTokens); err != nil {
			return stats, err
		}
		t := tools[tool]
		if t == nil {
			t = &ToolStats{Tool: tool}
			tools[tool] = t
		}
		t.Calls++
		toolDurations[tool] = append(toolDurations[tool], duration)
		b := &stats.Buckets[min(count-1, max(0, int((ts-first)/size)))]
		b.Calls++
		if status != StatusOK {
			t.Errors++
			b.Errors++
		}
		stats.Usage = stats.Usage.Add(usage)
	}
	if err := rows.Err(); err != nil {
		return stats, err
	}
	for name, t := range tools {
		d := toolDurations[name]
		slices.Sort(d)
		t.P50Ms, t.P95Ms = percentile(d, 0.5), percentile(d, 0.95)
		stats.Tools = append(stats.Tools, *t)
	}
	slices.SortFunc(stats.Tools, func(a, b ToolStats) int { return strings.Compare(a.Tool, b.Tool) })

	attempts, err := s.db.QueryContext(ctx, `
		SELECT json_extract(a.value, '$.kind'), json_extract(a.value, '$.provider'),
		       json_extract(a.value, '$.status'), json_extract(a.value, '$.duration_ms')
		FROM request_logs, json_each(request_logs.attempts) a
		WHERE ts >= ?`, since)
	if err != nil {
		return stats, err
	}
	defer attempts.Close()
	providers := map[[2]string]*ProviderStats{}
	providerDurations := map[[2]string][]int64{}
	for attempts.Next() {
		var kind, provider, status sql.NullString
		var duration sql.NullInt64
		if err := attempts.Scan(&kind, &provider, &status, &duration); err != nil {
			return stats, err
		}
		if status.String == "cached" || status.String == "skipped" {
			continue
		}
		key := [2]string{kind.String, provider.String}
		p := providers[key]
		if p == nil {
			p = &ProviderStats{Kind: kind.String, Provider: provider.String}
			providers[key] = p
		}
		p.Calls++
		switch status.String {
		case "ok":
			p.Wins++
			providerDurations[key] = append(providerDurations[key], duration.Int64)
		case "canceled":
			p.Canceled++
		default:
			p.Errors++
		}
	}
	if err := attempts.Err(); err != nil {
		return stats, err
	}
	for key, p := range providers {
		d := providerDurations[key]
		slices.Sort(d)
		p.P50Ms, p.P95Ms = percentile(d, 0.5), percentile(d, 0.95)
		stats.Providers = append(stats.Providers, *p)
	}
	slices.SortFunc(stats.Providers, func(a, b ProviderStats) int {
		if c := strings.Compare(a.Kind, b.Kind); c != 0 {
			return c
		}
		return b.Calls - a.Calls
	})
	return stats, nil
}
