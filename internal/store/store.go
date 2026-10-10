// Package store persists everything in one SQLite file: the configuration
// document, admin credentials and sessions, API keys, request logs and
// research tasks.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS kv (
	key   TEXT PRIMARY KEY,
	value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	hash       TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	name         TEXT NOT NULL,
	prefix       TEXT NOT NULL,
	hash         TEXT NOT NULL UNIQUE,
	scopes       TEXT NOT NULL,
	rate_limit   TEXT NOT NULL DEFAULT '',
	created_at   INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at   INTEGER
);
CREATE TABLE IF NOT EXISTS request_logs (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	ts            INTEGER NOT NULL,
	tool          TEXT NOT NULL,
	source        TEXT NOT NULL,
	api_key_id    INTEGER NOT NULL DEFAULT 0,
	api_key_name  TEXT NOT NULL DEFAULT '',
	status        TEXT NOT NULL,
	duration_ms   INTEGER NOT NULL,
	provider      TEXT NOT NULL DEFAULT '',
	summary       TEXT NOT NULL DEFAULT '',
	request       TEXT NOT NULL DEFAULT '',
	response      TEXT NOT NULL DEFAULT '',
	error         TEXT NOT NULL DEFAULT '',
	attempts      TEXT NOT NULL DEFAULT '[]',
	input_tokens  INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS request_logs_ts ON request_logs (ts);
CREATE TABLE IF NOT EXISTS research_tasks (
	id         TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	status     TEXT NOT NULL,
	question   TEXT NOT NULL,
	progress   TEXT NOT NULL DEFAULT '',
	result     TEXT NOT NULL DEFAULT '',
	error      TEXT NOT NULL DEFAULT '',
	steps      TEXT NOT NULL DEFAULT '[]',
	stats      TEXT NOT NULL DEFAULT '',
	budget     TEXT NOT NULL DEFAULT '',
	spent      TEXT NOT NULL DEFAULT '',
	draft      TEXT NOT NULL DEFAULT ''
);
`

// added lists the columns that came after the first release, which a
// database created by an earlier version gains when it is opened.
var added = []struct{ table, column, definition string }{
	{"request_logs", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"request_logs", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"research_tasks", "steps", "TEXT NOT NULL DEFAULT '[]'"},
	{"research_tasks", "stats", "TEXT NOT NULL DEFAULT ''"},
	{"research_tasks", "budget", "TEXT NOT NULL DEFAULT ''"},
	{"research_tasks", "spent", "TEXT NOT NULL DEFAULT ''"},
	{"research_tasks", "draft", "TEXT NOT NULL DEFAULT ''"},
}

// Open opens, and creates if needed, the database in dir.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "seekmux.db")
	query := url.Values{}
	for _, pragma := range []string{
		"journal_mode(WAL)", "synchronous(NORMAL)", "busy_timeout(5000)",
		// Keep the page cache small: the target is a low-memory server.
		"cache_size(-4000)", "foreign_keys(1)",
	} {
		query.Add("_pragma", pragma)
	}
	db, err := sql.Open("sqlite", "file:"+path+"?"+query.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init database %s: %w", path, err)
	}
	for _, c := range added {
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info(?) WHERE name = ?`, c.table, c.column).Scan(&n); err == nil && n == 0 {
			if _, err := db.Exec(`ALTER TABLE ` + c.table + ` ADD COLUMN ` + c.column + ` ` + c.definition); err != nil {
				db.Close()
				return nil, fmt.Errorf("init database %s: %w", path, err)
			}
		}
	}
	// The database holds API keys in plain text.
	_ = os.Chmod(path, 0o600)
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func now() int64 { return time.Now().UnixMilli() }

// Get returns the value stored under key, or nil when there is none.
func (s *Store) Get(ctx context.Context, key string) ([]byte, error) {
	var value []byte
	err := s.db.QueryRowContext(ctx, `SELECT value FROM kv WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return value, err
}

// Set stores value under key; a nil value removes the key.
func (s *Store) Set(ctx context.Context, key string, value []byte) error {
	if value == nil {
		_, err := s.db.ExecContext(ctx, `DELETE FROM kv WHERE key = ?`, key)
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// CreateSession stores the hash of a session token.
func (s *Store) CreateSession(ctx context.Context, hash string, ttl time.Duration) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions (hash, expires_at) VALUES (?, ?)`,
		hash, time.Now().Add(ttl).UnixMilli())
	return err
}

func (s *Store) SessionValid(ctx context.Context, hash string) (bool, error) {
	var expires int64
	err := s.db.QueryRowContext(ctx, `SELECT expires_at FROM sessions WHERE hash = ?`, hash).Scan(&expires)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil && expires > now(), err
}

func (s *Store) DeleteSession(ctx context.Context, hash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE hash = ?`, hash)
	return err
}

// DeleteSessions signs every session out, optionally keeping one.
func (s *Store) DeleteSessions(ctx context.Context, keepHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE hash != ?`, keepHash)
	return err
}

func (s *Store) pruneSessions(ctx context.Context) {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, now())
}
