package store

import (
	"cmp"
	"context"
	"slices"
	"sync"
	"time"
)

// DomainRetentionDays is how long the statistics per domain are kept. They
// outlive the request logs: a site that turns crawlers away shows over weeks.
const DomainRetentionDays = 90

const dayMs = 24 * 60 * 60 * 1000

// DomainSample is how one provider's attempt at a page of a domain ended.
type DomainSample struct {
	TS       int64
	Domain   string
	Provider string
	// Outcome is one of the outcomes the fetch package names.
	Outcome    string
	DurationMs int64
	Bytes      int64
}

type domainKey struct {
	day                       int64
	domain, provider, outcome string
}

type domainSum struct{ count, durationMs, bytes int64 }

// DomainWriter adds samples up in memory and writes the sums every few
// seconds, so a fetch never waits on the disk and a busy domain costs one row
// per provider, outcome and day.
type DomainWriter struct {
	store *Store
	stop  chan struct{}
	done  chan struct{}

	mu      sync.Mutex
	pending map[domainKey]domainSum
	closed  bool
}

func (s *Store) NewDomainWriter() *DomainWriter {
	w := &DomainWriter{store: s, stop: make(chan struct{}), done: make(chan struct{}), pending: map[domainKey]domainSum{}}
	go w.run()
	return w
}

func (w *DomainWriter) Record(sample DomainSample) {
	key := domainKey{sample.TS / dayMs, sample.Domain, sample.Provider, sample.Outcome}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	sum := w.pending[key]
	w.pending[key] = domainSum{sum.count + 1, sum.durationMs + sample.DurationMs, sum.bytes + sample.Bytes}
}

// Close writes what is pending.
func (w *DomainWriter) Close() {
	w.mu.Lock()
	closed := w.closed
	w.closed = true
	w.mu.Unlock()
	if !closed {
		close(w.stop)
	}
	<-w.done
}

func (w *DomainWriter) run() {
	defer close(w.done)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			w.flush()
		case <-w.stop:
			w.flush()
			return
		}
	}
}

func (w *DomainWriter) flush() {
	w.mu.Lock()
	pending := w.pending
	w.pending = map[domainKey]domainSum{}
	w.mu.Unlock()
	if len(pending) == 0 {
		return
	}
	tx, err := w.store.db.Begin()
	if err != nil {
		return
	}
	for key, sum := range pending {
		_, _ = tx.Exec(`INSERT INTO domain_stats (day, domain, provider, outcome, count, duration_ms, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (day, domain, provider, outcome) DO UPDATE SET
				count = count + excluded.count, duration_ms = duration_ms + excluded.duration_ms, bytes = bytes + excluded.bytes`,
			key.day, key.domain, key.provider, key.outcome, sum.count, sum.durationMs, sum.bytes)
	}
	_ = tx.Commit()
}

// DomainProviderStats is what one provider made of the pages of a domain.
type DomainProviderStats struct {
	Provider string `json:"provider"`
	Calls    int64  `json:"calls"`
	// Outcomes counts the calls by how they ended.
	Outcomes map[string]int64 `json:"outcomes"`
	// AvgMs and AvgBytes are the mean duration and text size of the pages it
	// read. A provider that reads far less than the others on the same domain
	// is getting the page without its content.
	AvgMs    int64 `json:"avg_ms"`
	AvgBytes int64 `json:"avg_bytes"`
}

// DomainStats is how fetches of a domain's pages went, per provider.
type DomainStats struct {
	Domain    string                `json:"domain"`
	Calls     int64                 `json:"calls"`
	Outcomes  map[string]int64      `json:"outcomes"`
	Providers []DomainProviderStats `json:"providers"`
}

// DomainStats returns the statistics of the last days, busiest domain first,
// at most limit domains.
func (s *Store) DomainStats(ctx context.Context, days, limit int) ([]DomainStats, error) {
	since := time.Now().UnixMilli()/dayMs - int64(days) + 1
	rows, err := s.db.QueryContext(ctx, `SELECT domain, provider, outcome, sum(count), sum(duration_ms), sum(bytes)
		FROM domain_stats WHERE day >= ? GROUP BY domain, provider, outcome`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	domains := map[string]*DomainStats{}
	providers := map[[2]string]*DomainProviderStats{}
	for rows.Next() {
		var domain, provider, outcome string
		var count, duration, bytes int64
		if err := rows.Scan(&domain, &provider, &outcome, &count, &duration, &bytes); err != nil {
			return nil, err
		}
		d := domains[domain]
		if d == nil {
			d = &DomainStats{Domain: domain, Outcomes: map[string]int64{}}
			domains[domain] = d
		}
		p := providers[[2]string{domain, provider}]
		if p == nil {
			p = &DomainProviderStats{Provider: provider, Outcomes: map[string]int64{}}
			providers[[2]string{domain, provider}] = p
		}
		d.Calls += count
		d.Outcomes[outcome] += count
		p.Calls += count
		p.Outcomes[outcome] += count
		// Only a page that was read has a size and a time worth comparing.
		if outcome == "ok" && count > 0 {
			p.AvgMs, p.AvgBytes = duration/count, bytes/count
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for key, p := range providers {
		domains[key[0]].Providers = append(domains[key[0]].Providers, *p)
	}
	out := make([]DomainStats, 0, len(domains))
	for _, d := range domains {
		slices.SortFunc(d.Providers, func(a, b DomainProviderStats) int {
			return cmp.Or(cmp.Compare(b.Calls, a.Calls), cmp.Compare(a.Provider, b.Provider))
		})
		out = append(out, *d)
	}
	slices.SortFunc(out, func(a, b DomainStats) int {
		return cmp.Or(cmp.Compare(b.Calls, a.Calls), cmp.Compare(a.Domain, b.Domain))
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *Store) ClearDomainStats(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM domain_stats`)
	return err
}

func (s *Store) pruneDomainStats(ctx context.Context) {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM domain_stats WHERE day < ?`, time.Now().UnixMilli()/dayMs-DomainRetentionDays)
}
