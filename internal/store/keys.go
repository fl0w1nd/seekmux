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
func (s *Store) CreateAPIKey(ctx context.Context, name string, scopes []string, rateLimit string) (APIKey, string, error) {
	secret := NewToken(KeyPrefix)
	key := APIKey{Name: name, Prefix: secret[:len(KeyPrefix)+6], Scopes: scopes, RateLimit: rateLimit, CreatedAt: now()}
	scopeJSON, _ := json.Marshal(scopes)
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO api_keys (name, prefix, hash, scopes, rate_limit, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		key.Name, key.Prefix, HashToken(secret), string(scopeJSON), rateLimit, key.CreatedAt)
	if err != nil {
		return APIKey{}, "", err
	}
	key.ID, _ = res.LastInsertId()
	return key, secret, nil
}

const keyColumns = `id, name, prefix, scopes, rate_limit, created_at, COALESCE(last_used_at, 0), COALESCE(revoked_at, 0)`

func scanKey(row interface{ Scan(...any) error }) (APIKey, error) {
	var key APIKey
	var scopes string
	err := row.Scan(&key.ID, &key.Name, &key.Prefix, &scopes, &key.RateLimit, &key.CreatedAt, &key.LastUsedAt, &key.RevokedAt)
	if err != nil {
		return APIKey{}, err
	}
	_ = json.Unmarshal([]byte(scopes), &key.Scopes)
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

// LookupAPIKey returns the active key matching the secret.
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

func (s *Store) UpdateAPIKey(ctx context.Context, id int64, name string, scopes []string, rateLimit string) error {
	scopeJSON, _ := json.Marshal(scopes)
	_, err := s.db.ExecContext(ctx, `UPDATE api_keys SET name = ?, scopes = ?, rate_limit = ? WHERE id = ?`,
		name, string(scopeJSON), rateLimit, id)
	return err
}

func (s *Store) RevokeAPIKey(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now(), id)
	return err
}

func (s *Store) DeleteAPIKey(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM api_keys WHERE id = ?`, id)
	return err
}
