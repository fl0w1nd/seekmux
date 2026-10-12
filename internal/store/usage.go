package store

import (
	"cmp"
	"context"
	"slices"
	"sync"
	"time"

	"github.com/fl0w1nd/seekmux/internal/core"
)

// KeyUsageRetentionDays is how long the usage of a key is kept. It outlives
// the request logs, which are pruned by age and by size: what a key has used
// is asked about over months.
const KeyUsageRetentionDays = 400

// The kinds of usage a key adds up. Any other kind is the tool an upstream
// request was made for (search, dev_search, fetch), with the provider as name.
const (
	// UsageCall counts the tool calls themselves; the name is empty.
	UsageCall = "call"
	// UsageModel counts the requests to a model and their tokens, with the
	// model id as name.
	UsageModel = "model"
)

// UsageCount is a number of calls and the tokens they spent.
type UsageCount struct {
	Calls  int64 `json:"calls"`
	Errors int64 `json:"errors"`
	core.Usage
}

func (c UsageCount) add(o UsageCount) UsageCount {
	return UsageCount{Calls: c.Calls + o.Calls, Errors: c.Errors + o.Errors, Usage: c.Usage.Add(o.Usage)}
}

// UsageSample is usage of one kind by one key, during a call of Tool.
type UsageSample struct {
	TS    int64
	KeyID int64
	Tool  string
	Kind  string
	Name  string
	UsageCount
}

type usageKey struct {
	day, keyID       int64
	tool, kind, name string
}

// UsageWriter adds samples up in memory and writes the sums every few
// seconds, as DomainWriter does.
type UsageWriter struct {
	store *Store
	stop  chan struct{}
	done  chan struct{}

	mu      sync.Mutex
	pending map[usageKey]UsageCount
	closed  bool
}

func (s *Store) NewUsageWriter() *UsageWriter {
	w := &UsageWriter{store: s, stop: make(chan struct{}), done: make(chan struct{}), pending: map[usageKey]UsageCount{}}
	go w.run()
	return w
}

func (w *UsageWriter) Record(samples ...UsageSample) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	for _, sample := range samples {
		key := usageKey{sample.TS / dayMs, sample.KeyID, sample.Tool, sample.Kind, sample.Name}
		w.pending[key] = w.pending[key].add(sample.UsageCount)
	}
}

// Flush writes what is pending.
func (w *UsageWriter) Flush() {
	w.mu.Lock()
	pending := w.pending
	w.pending = map[usageKey]UsageCount{}
	w.mu.Unlock()
	if len(pending) == 0 {
		return
	}
	tx, err := w.store.db.Begin()
	if err != nil {
		return
	}
	for key, sum := range pending {
		_, _ = tx.Exec(`INSERT INTO key_usage
			(day, api_key_id, tool, kind, name, calls, errors, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (day, api_key_id, tool, kind, name) DO UPDATE SET
				calls = calls + excluded.calls, errors = errors + excluded.errors,
				input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
				cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
				cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
			key.day, key.keyID, key.tool, key.kind, key.name, sum.Calls, sum.Errors,
			sum.InputTokens, sum.OutputTokens, sum.CacheReadTokens, sum.CacheWriteTokens)
	}
	_ = tx.Commit()
}

// Close writes what is pending.
func (w *UsageWriter) Close() {
	w.mu.Lock()
	closed := w.closed
	w.closed = true
	w.mu.Unlock()
	if !closed {
		close(w.stop)
	}
	<-w.done
}

func (w *UsageWriter) run() {
	defer close(w.done)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			w.Flush()
		case <-w.stop:
			w.Flush()
			return
		}
	}
}

// UsageDay is the usage of one day, which starts at TS (midnight UTC, in ms).
type UsageDay struct {
	TS int64 `json:"ts"`
	UsageCount
}

// ToolUsage is the calls of one tool and the tokens they spent.
type ToolUsage struct {
	Tool string `json:"tool"`
	UsageCount
}

// ProviderUsage counts the upstream requests to one provider for one kind of
// call. A research run's own searches and fetches count under their kind.
type ProviderUsage struct {
	Kind     string `json:"kind"`
	Provider string `json:"provider"`
	Calls    int64  `json:"calls"`
	Errors   int64  `json:"errors"`
}

// ModelUsage is the requests to one model and their tokens.
type ModelUsage struct {
	Model string `json:"model"`
	UsageCount
}

// KeyUsage is what one key used over a number of days.
type KeyUsage struct {
	// Total counts the tool calls and every token.
	Total UsageCount `json:"total"`
	// Days has an entry for every day asked for, oldest first.
	Days      []UsageDay      `json:"days"`
	Tools     []ToolUsage     `json:"tools"`
	Providers []ProviderUsage `json:"providers"`
	Models    []ModelUsage    `json:"models"`
}

func usageSince(days int) int64 { return time.Now().UnixMilli()/dayMs - int64(days) + 1 }

// KeyUsage returns the usage of the key with the given id over the last days.
func (s *Store) KeyUsage(ctx context.Context, id int64, days int) (KeyUsage, error) {
	since := usageSince(days)
	rows, err := s.db.QueryContext(ctx, `SELECT day, tool, kind, name, calls, errors, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
		FROM key_usage WHERE api_key_id = ? AND day >= ?`, id, since)
	if err != nil {
		return KeyUsage{}, err
	}
	defer rows.Close()

	out := KeyUsage{Days: make([]UsageDay, days), Tools: []ToolUsage{}, Providers: []ProviderUsage{}, Models: []ModelUsage{}}
	for i := range out.Days {
		out.Days[i].TS = (since + int64(i)) * dayMs
	}
	tools := map[string]*ToolUsage{}
	providers := map[[2]string]*ProviderUsage{}
	models := map[string]*ModelUsage{}
	for rows.Next() {
		var day int64
		var tool, kind, name string
		var c UsageCount
		if err := rows.Scan(&day, &tool, &kind, &name, &c.Calls, &c.Errors, &c.InputTokens, &c.OutputTokens, &c.CacheReadTokens, &c.CacheWriteTokens); err != nil {
			return KeyUsage{}, err
		}
		if day < since || day >= since+int64(days) {
			continue
		}
		t := tools[tool]
		if t == nil {
			t = &ToolUsage{Tool: tool}
			tools[tool] = t
		}
		switch kind {
		case UsageCall:
			out.Total = out.Total.add(c)
			out.Days[day-since].UsageCount = out.Days[day-since].add(c)
			t.UsageCount = t.add(c)
		case UsageModel:
			// The requests to a model are counted with the model alone: a tool
			// call is one call however many requests it took.
			tokens := UsageCount{Usage: c.Usage}
			out.Total = out.Total.add(tokens)
			out.Days[day-since].UsageCount = out.Days[day-since].add(tokens)
			t.UsageCount = t.add(tokens)
			m := models[name]
			if m == nil {
				m = &ModelUsage{Model: name}
				models[name] = m
			}
			m.UsageCount = m.add(c)
		default:
			p := providers[[2]string{kind, name}]
			if p == nil {
				p = &ProviderUsage{Kind: kind, Provider: name}
				providers[[2]string{kind, name}] = p
			}
			p.Calls += c.Calls
			p.Errors += c.Errors
		}
	}
	if err := rows.Err(); err != nil {
		return KeyUsage{}, err
	}
	for _, t := range tools {
		out.Tools = append(out.Tools, *t)
	}
	for _, p := range providers {
		out.Providers = append(out.Providers, *p)
	}
	for _, m := range models {
		out.Models = append(out.Models, *m)
	}
	slices.SortFunc(out.Tools, func(a, b ToolUsage) int {
		return cmp.Or(cmp.Compare(b.Calls, a.Calls), cmp.Compare(a.Tool, b.Tool))
	})
	slices.SortFunc(out.Providers, func(a, b ProviderUsage) int {
		return cmp.Or(cmp.Compare(a.Kind, b.Kind), cmp.Compare(b.Calls, a.Calls), cmp.Compare(a.Provider, b.Provider))
	})
	slices.SortFunc(out.Models, func(a, b ModelUsage) int {
		return cmp.Or(cmp.Compare(b.InputTokens+b.OutputTokens, a.InputTokens+a.OutputTokens), cmp.Compare(a.Model, b.Model))
	})
	return out, nil
}

// KeyUsageTotals returns the tool calls and tokens of every key over the
// last days, by key id.
func (s *Store) KeyUsageTotals(ctx context.Context, days int) (map[int64]UsageCount, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT api_key_id, kind, sum(calls), sum(errors),
			sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens)
		FROM key_usage WHERE day >= ? AND kind IN (?, ?) GROUP BY api_key_id, kind`, usageSince(days), UsageCall, UsageModel)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	totals := map[int64]UsageCount{}
	for rows.Next() {
		var id int64
		var kind string
		var c UsageCount
		if err := rows.Scan(&id, &kind, &c.Calls, &c.Errors, &c.InputTokens, &c.OutputTokens, &c.CacheReadTokens, &c.CacheWriteTokens); err != nil {
			return nil, err
		}
		if kind == UsageModel {
			c.Calls, c.Errors = 0, 0
		}
		totals[id] = totals[id].add(c)
	}
	return totals, rows.Err()
}

func (s *Store) pruneKeyUsage(ctx context.Context) {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM key_usage WHERE day < ?`, time.Now().UnixMilli()/dayMs-KeyUsageRetentionDays)
}
