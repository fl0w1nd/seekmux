package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// The prefixes of what an OAuth client is handed, so that each is
// recognizable in a leak scan and told apart from an API key.
const (
	ClientPrefix       = "smc_"
	AccessTokenPrefix  = "smo_"
	RefreshTokenPrefix = "smr_"
)

const (
	tokenAccess  = "access"
	tokenRefresh = "refresh"
)

// OAuthClient is an MCP client that registered itself. Everything in it but
// the id is what the client said of itself.
type OAuthClient struct {
	ID string `json:"client_id"`
	// SecretHash is empty for a public client, which proves itself by PKCE alone.
	SecretHash   string   `json:"-"`
	Name         string   `json:"client_name"`
	URI          string   `json:"client_uri,omitempty"`
	RedirectURIs []string `json:"redirect_uris"`
	CreatedAt    int64    `json:"-"`
}

// CreateOAuthClient stores a client under a new id. With secret set it is
// given one, which is returned and cannot be recovered later.
func (s *Store) CreateOAuthClient(ctx context.Context, client OAuthClient, secret bool) (OAuthClient, string, error) {
	client.ID, client.CreatedAt = NewToken(ClientPrefix), now()
	plain := ""
	if secret {
		plain = NewToken("")
		client.SecretHash = HashToken(plain)
	}
	uris, _ := json.Marshal(client.RedirectURIs)
	_, err := s.db.ExecContext(ctx, `INSERT INTO oauth_clients (id, secret_hash, name, uri, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		client.ID, client.SecretHash, client.Name, client.URI, string(uris), client.CreatedAt)
	return client, plain, err
}

func (s *Store) GetOAuthClient(ctx context.Context, id string) (OAuthClient, bool, error) {
	client := OAuthClient{ID: id}
	var uris string
	err := s.db.QueryRowContext(ctx, `SELECT secret_hash, name, uri, redirect_uris, created_at FROM oauth_clients WHERE id = ?`, id).
		Scan(&client.SecretHash, &client.Name, &client.URI, &uris, &client.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return OAuthClient{}, false, nil
	}
	_ = json.Unmarshal([]byte(uris), &client.RedirectURIs)
	return client, err == nil, err
}

// CountOAuthClients returns how many clients are registered.
func (s *Store) CountOAuthClients(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM oauth_clients`).Scan(&n)
	return n, err
}

// OAuthKey returns the key that stands for a client, unless it is revoked.
func (s *Store) OAuthKey(ctx context.Context, client string) (APIKey, bool, error) {
	key, err := scanKey(s.db.QueryRowContext(ctx,
		`SELECT `+keyColumns+` FROM api_keys WHERE oauth_client = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, client))
	if errors.Is(err, sql.ErrNoRows) {
		return APIKey{}, false, nil
	}
	return key, err == nil, err
}

// SetKeyScopes replaces the tools a key may call.
func (s *Store) SetKeyScopes(ctx context.Context, id int64, scopes []string) error {
	scopeJSON, _ := json.Marshal(scopes)
	_, err := s.db.ExecContext(ctx, `UPDATE api_keys SET scopes = ? WHERE id = ?`, string(scopeJSON), id)
	return err
}

// OAuthTokens is a pair of tokens with the lifetime of the access token.
type OAuthTokens struct {
	Access, Refresh string
	ExpiresIn       time.Duration
}

// IssueOAuthTokens gives a client a new access and refresh token for a key.
func (s *Store) IssueOAuthTokens(ctx context.Context, client string, key int64, access, refresh time.Duration) (OAuthTokens, error) {
	tokens := OAuthTokens{Access: NewToken(AccessTokenPrefix), Refresh: NewToken(RefreshTokenPrefix), ExpiresIn: access}
	at := time.Now()
	_, err := s.db.ExecContext(ctx, `INSERT INTO oauth_tokens (hash, kind, client_id, api_key_id, expires_at) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
		HashToken(tokens.Access), tokenAccess, client, key, at.Add(access).UnixMilli(),
		HashToken(tokens.Refresh), tokenRefresh, client, key, at.Add(refresh).UnixMilli())
	return tokens, err
}

// LookupAccessToken returns the key an access token calls with, unless the
// token has expired or the key is revoked. The caller turns away a key that
// has expired.
func (s *Store) LookupAccessToken(ctx context.Context, token string) (APIKey, bool, error) {
	if !strings.HasPrefix(token, AccessTokenPrefix) {
		return APIKey{}, false, nil
	}
	key, err := scanKey(s.db.QueryRowContext(ctx,
		`SELECT `+keyColumns+` FROM api_keys WHERE revoked_at IS NULL AND id =
			(SELECT api_key_id FROM oauth_tokens WHERE hash = ? AND kind = ? AND expires_at > ?)`,
		HashToken(token), tokenAccess, now()))
	if errors.Is(err, sql.ErrNoRows) {
		return APIKey{}, false, nil
	}
	return key, err == nil, err
}

// RedeemRefreshToken returns the key a client's refresh token stands for and
// retires the token. It stays good for grace longer, so a client whose
// answer got lost, or that refreshes from two places at once, is not signed
// out.
func (s *Store) RedeemRefreshToken(ctx context.Context, client, token string, grace time.Duration) (APIKey, bool, error) {
	if !strings.HasPrefix(token, RefreshTokenPrefix) {
		return APIKey{}, false, nil
	}
	hash := HashToken(token)
	key, err := scanKey(s.db.QueryRowContext(ctx,
		`SELECT `+keyColumns+` FROM api_keys WHERE revoked_at IS NULL AND id =
			(SELECT api_key_id FROM oauth_tokens WHERE hash = ? AND kind = ? AND client_id = ? AND expires_at > ?)`,
		hash, tokenRefresh, client, now()))
	if errors.Is(err, sql.ErrNoRows) {
		return APIKey{}, false, nil
	}
	if err != nil {
		return APIKey{}, false, err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE oauth_tokens SET expires_at = min(expires_at, ?) WHERE hash = ?`, time.Now().Add(grace).UnixMilli(), hash)
	return key, err == nil, err
}

func (s *Store) deleteOAuthTokens(ctx context.Context, key int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM oauth_tokens WHERE api_key_id = ?`, key)
	return err
}

// pruneOAuth drops the tokens that have expired and the clients that
// registered more than unused ago without ever being authorized, or whose
// key is gone.
func (s *Store) pruneOAuth(ctx context.Context, unused time.Duration) {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM oauth_tokens WHERE expires_at <= ?`, now())
	_, _ = s.db.ExecContext(ctx, `DELETE FROM oauth_clients WHERE created_at <= ? AND id NOT IN (SELECT oauth_client FROM api_keys)`,
		time.Now().Add(-unused).UnixMilli())
}
