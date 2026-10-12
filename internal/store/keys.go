package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
)

// KeyPrefix starts every API key so one is recognizable in a config or a leak scan.
const KeyPrefix = "smx_"

// APIKey authorizes MCP calls. Only the hash of the secret is stored.
type APIKey struct {
	ID         int64    `json:"id"`
	Name       string   `json:"name"`
	Prefix     string   `json:"prefix"`
	Scopes     []string `json:"scopes"`
	RateLimit  string   `json:"rate_limit"`
	CreatedAt  int64    `json:"created_at"`
	LastUsedAt int64    `json:"last_used_at,omitempty"`
	RevokedAt  int64    `json:"revoked_at,omitempty"`
	// ExpiresAt is when the key stops working, in ms; 0 means never.
	ExpiresAt int64     `json:"expires_at,omitempty"`
	Policy    KeyPolicy `json:"policy"`
}

// Expired reports whether the key has passed its expiry.
func (k APIKey) Expired() bool { return k.ExpiresAt > 0 && k.ExpiresAt <= now() }

// KeyPolicy is what a key changes about the calls it makes. The zero policy
// changes nothing.
type KeyPolicy struct {
	// ExtractModels replaces the extract chain, in order. A model that no
	// longer exists is left out; when none is left the configured chain serves.
	ExtractModels []string `json:"extract_models,omitempty"`
	// ResearchModel replaces the model of the research agent.
	ResearchModel string      `json:"research_model,omitempty"`
	Research      KeyResearch `json:"research"`
}

// KeyResearch bounds the research runs of a key. A zero field leaves what is
// configured.
type KeyResearch struct {
	// MaxSteps, MaxDurationSeconds and MaxTokens are ceilings: a run gets the
	// smaller of the ceiling and the configured budget.
	MaxSteps           int   `json:"max_steps,omitempty"`
	MaxDurationSeconds int   `json:"max_duration_seconds,omitempty"`
	MaxTokens          int64 `json:"max_tokens,omitempty"`
	// QuickOnly makes every run a quick one, whatever effort it asks for.
	QuickOnly bool `json:"quick_only,omitempty"`
	// Concurrency is how many runs the key may have under way at once.
	Concurrency int `json:"concurrency,omitempty"`
}

// KeySpec is what an API key is created with and what can be changed later.
type KeySpec struct {
	Name      string
	Scopes    []string
	RateLimit string
	ExpiresAt int64
	Policy    KeyPolicy
}

// HashToken returns the stored form of a secret token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewToken returns a random token with 160 bits of entropy.
func NewToken(prefix string) string {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return prefix + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw))
}

// CreateAPIKey stores a new key and returns it with its secret, which cannot
// be recovered later.
func (s *Store) CreateAPIKey(ctx context.Context, spec KeySpec) (APIKey, string, error) {
	secret := NewToken(KeyPrefix)
	key := APIKey{
		Name: spec.Name, Prefix: secret[:len(KeyPrefix)+6], Scopes: spec.Scopes, RateLimit: spec.RateLimit,
		CreatedAt: now(), ExpiresAt: spec.ExpiresAt, Policy: spec.Policy,
	}
	scopeJSON, _ := json.Marshal(spec.Scopes)
	policyJSON, _ := json.Marshal(spec.Policy)
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO api_keys (name, prefix, hash, scopes, rate_limit, created_at, expires_at, policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		key.Name, key.Prefix, HashToken(secret), string(scopeJSON), spec.RateLimit, key.CreatedAt, spec.ExpiresAt, string(policyJSON))
	if err != nil {
		return APIKey{}, "", err
	}
	key.ID, _ = res.LastInsertId()
	return key, secret, nil
}

const keyColumns = `id, name, prefix, scopes, rate_limit, created_at, COALESCE(last_used_at, 0), COALESCE(revoked_at, 0), expires_at, policy`

func scanKey(row interface{ Scan(...any) error }) (APIKey, error) {
	var key APIKey
	var scopes, policy string
	err := row.Scan(&key.ID, &key.Name, &key.Prefix, &scopes, &key.RateLimit, &key.CreatedAt, &key.LastUsedAt, &key.RevokedAt, &key.ExpiresAt, &policy)
	if err != nil {
		return APIKey{}, err
	}
	_ = json.Unmarshal([]byte(scopes), &key.Scopes)
	// A key from before policies has none stored.
	if policy != "" {
		_ = json.Unmarshal([]byte(policy), &key.Policy)
	}
	return key, nil
}

func (s *Store) ListAPIKeys(ctx context.Context) ([]APIKey, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+keyColumns+` FROM api_keys ORDER BY revoked_at IS NOT NULL, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := []APIKey{}
	for rows.Next() {
		key, err := scanKey(rows)
		if err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

// LookupAPIKey returns the key matching the secret unless it is revoked. The
// caller turns away one that has expired.
func (s *Store) LookupAPIKey(ctx context.Context, secret string) (APIKey, bool, error) {
	if !strings.HasPrefix(secret, KeyPrefix) {
		return APIKey{}, false, nil
	}
	key, err := scanKey(s.db.QueryRowContext(ctx,
		`SELECT `+keyColumns+` FROM api_keys WHERE hash = ? AND revoked_at IS NULL`, HashToken(secret)))
	if errors.Is(err, sql.ErrNoRows) {
		return APIKey{}, false, nil
	}
	return key, err == nil, err
}

func (s *Store) TouchAPIKey(ctx context.Context, id int64) {
	_, _ = s.db.ExecContext(ctx, `UPDATE api_keys SET last_used_at = ? WHERE id = ?`, now(), id)
}

func (s *Store) UpdateAPIKey(ctx context.Context, id int64, spec KeySpec) error {
	scopeJSON, _ := json.Marshal(spec.Scopes)
	policyJSON, _ := json.Marshal(spec.Policy)
	_, err := s.db.ExecContext(ctx, `UPDATE api_keys SET name = ?, scopes = ?, rate_limit = ?, expires_at = ?, policy = ? WHERE id = ?`,
		spec.Name, string(scopeJSON), spec.RateLimit, spec.ExpiresAt, string(policyJSON), id)
	return err
}

func (s *Store) RevokeAPIKey(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now(), id)
	return err
}

func (s *Store) DeleteAPIKey(ctx context.Context, id int64) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM api_keys WHERE id = ?`, id); err != nil {
		return err
	}
	// Its usage has nowhere left to be shown.
	_, err := s.db.ExecContext(ctx, `DELETE FROM key_usage WHERE api_key_id = ?`, id)
	return err
}
