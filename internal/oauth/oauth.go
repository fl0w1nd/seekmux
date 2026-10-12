// Package oauth lets an MCP client sign in instead of being handed an API
// key. The gateway is its own authorization server: a client registers
// itself, the admin approves it in the console, and the client calls with
// tokens that stand for an API key made for it.
package oauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/fl0w1nd/seekmux/internal/app"
	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/store"
)

const (
	// ResourceMetadataPath is where the MCP endpoint says who authorizes it.
	ResourceMetadataPath = "/.well-known/oauth-protected-resource/mcp"

	authorizePath = "/oauth/authorize"
	tokenPath     = "/oauth/token"
	registerPath  = "/oauth/register"

	accessTTL  = time.Hour
	refreshTTL = 90 * 24 * time.Hour
	// refreshGrace is how long a refresh token still works after it was used.
	refreshGrace = time.Minute
	codeTTL      = 5 * time.Minute

	maxClients      = 1000
	maxRedirectURIs = 10
	maxURI          = 2000
	maxName         = 64
	maxBody         = 64 << 10
)

// Server is the authorization server.
type Server struct {
	app *app.App

	mu sync.Mutex
	// codes holds the approvals not yet redeemed, by the hash of their code.
	codes map[string]approval
}

// approval is what the admin granted, waiting for the client to redeem it.
type approval struct {
	client      string
	redirectURI string
	challenge   string
	scopes      []string
	expires     time.Time
}

func New(a *app.App) *Server {
	return &Server{app: a, codes: map[string]approval{}}
}

func (s *Server) enabled() bool { return !s.app.Snapshot().Config.OAuth.Disabled }

func (s *Server) issuer(r *http.Request) string { return s.app.Snapshot().PublicURL(r) }

// Mount adds the endpoints a client talks to. The page the admin approves a
// client on, at /oauth/authorize, is the console's.
func (s *Server) Mount(mux *http.ServeMux) {
	resource := s.open(http.MethodGet, s.handleResourceMetadata)
	mux.Handle("/.well-known/oauth-protected-resource", resource)
	mux.Handle(ResourceMetadataPath, resource)
	mux.Handle("/.well-known/oauth-authorization-server", s.open(http.MethodGet, s.handleServerMetadata))
	mux.Handle(registerPath, s.open(http.MethodPost, s.handleRegister))
	mux.Handle(tokenPath, s.open(http.MethodPost, s.handleToken))
}

// open serves an endpoint that browser-based clients call from their own
// origin. Nothing here goes by a cookie, so any origin may read the answer.
func (s *Server) open(method string, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		switch {
		case !s.enabled():
			http.NotFound(w, r)
		case r.Method == http.MethodOptions:
			w.Header().Set("Access-Control-Allow-Methods", method+", OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version")
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
		case r.Method != method:
			w.Header().Set("Allow", method+", OPTIONS")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		default:
			next(w, r)
		}
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// fail answers with an OAuth error, whose code a client acts on.
func fail(w http.ResponseWriter, status int, code, description string) {
	writeJSON(w, status, map[string]string{"error": code, "error_description": description})
}

// throttled turns a client address away once it has used up a budget.
func (s *Server) throttled(w http.ResponseWriter, r *http.Request, what string, limit config.RateLimit) bool {
	ok, wait := s.app.Limits.Rate.TryAcquire("oauth:"+what+":"+app.ClientAddr(r), limit)
	if !ok {
		w.Header().Set("Retry-After", fmt.Sprint(int(wait.Seconds())+1))
		fail(w, http.StatusTooManyRequests, "slow_down", "too many requests, try again in a minute")
	}
	return !ok
}

func (s *Server) handleResourceMetadata(w http.ResponseWriter, r *http.Request) {
	base := s.issuer(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 base + "/mcp",
		"resource_name":            "SeekMux",
		"authorization_servers":    []string{base},
		"scopes_supported":         config.Tools,
		"bearer_methods_supported": []string{"header"},
	})
}

func (s *Server) handleServerMetadata(w http.ResponseWriter, r *http.Request) {
	base := s.issuer(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         base,
		"authorization_endpoint":                         base + authorizePath,
		"token_endpoint":                                 base + tokenPath,
		"registration_endpoint":                          base + registerPath,
		"scopes_supported":                               config.Tools,
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"token_endpoint_auth_methods_supported":          []string{authNone, authPost, authBasic},
		"code_challenge_methods_supported":               []string{"S256"},
		"authorization_response_iss_parameter_supported": true,
	})
}

// The ways a client proves itself at the token endpoint.
const (
	authNone  = "none"
	authPost  = "client_secret_post"
	authBasic = "client_secret_basic"
)

// registration is the client metadata of RFC 7591 that is acted on; the
// rest of what a client sends is ignored.
type registration struct {
	RedirectURIs []string `json:"redirect_uris"`
	Name         string   `json:"client_name"`
	URI          string   `json:"client_uri"`
	AuthMethod   string   `json:"token_endpoint_auth_method"`
	GrantTypes   []string `json:"grant_types"`
}

// handleRegister lets a client register itself. Registering grants nothing:
// the client is unknown to the admin until it asks to be approved.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if s.throttled(w, r, "register", config.RateLimit{Requests: 10, Window: time.Minute}) {
		return
	}
	var body registration
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "invalid_client_metadata", "the body must be a JSON object of client metadata")
		return
	}
	if len(body.RedirectURIs) == 0 || len(body.RedirectURIs) > maxRedirectURIs {
		fail(w, http.StatusBadRequest, "invalid_redirect_uri", fmt.Sprintf("give between 1 and %d redirect_uris", maxRedirectURIs))
		return
	}
	for _, uri := range body.RedirectURIs {
		if err := checkRedirect(uri); err != nil {
			fail(w, http.StatusBadRequest, "invalid_redirect_uri", err.Error())
			return
		}
	}
	if len(body.GrantTypes) > 0 && !slices.Contains(body.GrantTypes, "authorization_code") {
		fail(w, http.StatusBadRequest, "invalid_client_metadata", "only the authorization_code grant, with refresh_token, is offered")
		return
	}
	// A client that names no method gets the default of RFC 7591.
	if body.AuthMethod == "" {
		body.AuthMethod = authBasic
	}
	if !slices.Contains([]string{authNone, authPost, authBasic}, body.AuthMethod) {
		fail(w, http.StatusBadRequest, "invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic")
		return
	}
	if n, err := s.app.Store.CountOAuthClients(r.Context()); err != nil || n >= maxClients {
		fail(w, http.StatusServiceUnavailable, "temporarily_unavailable", "too many clients are registered; try again later")
		return
	}

	client := store.OAuthClient{Name: displayName(body.Name), RedirectURIs: body.RedirectURIs}
	if u, err := url.Parse(body.URI); err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && len(body.URI) <= maxURI {
		client.URI = body.URI
	}
	client, secret, err := s.app.Store.CreateOAuthClient(r.Context(), client, body.AuthMethod != authNone)
	if err != nil {
		fail(w, http.StatusInternalServerError, "server_error", "the client could not be stored")
		return
	}
	out := map[string]any{
		"client_id":                  client.ID,
		"client_id_issued_at":        client.CreatedAt / 1000,
		"client_name":                client.Name,
		"redirect_uris":              client.RedirectURIs,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": body.AuthMethod,
	}
	if client.URI != "" {
		out["client_uri"] = client.URI
	}
	if secret != "" {
		out["client_secret"], out["client_secret_expires_at"] = secret, 0
	}
	writeJSON(w, http.StatusCreated, out)
}

// displayName reduces the name a client gives itself to one line that fits
// the name of an API key.
func displayName(raw string) string {
	name := strings.Join(strings.FieldsFunc(raw, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	for len(name) > maxName {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	if name == "" {
		return "MCP client"
	}
	return name
}

var schemePattern = regexp.MustCompile(`^[a-z][a-z0-9+.-]*$`)

// loopback reports whether u is a plain-HTTP address on this machine, which
// a desktop client listens on for its answer.
func loopback(u *url.URL) bool {
	if u.Scheme != "http" {
		return false
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

// checkRedirect accepts the addresses an approval may be sent to: HTTPS, a
// loopback address, or the private scheme of a native app.
func checkRedirect(raw string) error {
	u, err := url.Parse(raw)
	switch {
	case err != nil || len(raw) > maxURI || !schemePattern.MatchString(u.Scheme) || u.Fragment != "" || strings.Contains(raw, "#"):
		return fmt.Errorf("%q is not a valid redirect URI", raw)
	case u.Scheme == "https":
		if u.Host == "" {
			return fmt.Errorf("%q has no host", raw)
		}
	case u.Scheme == "http":
		if !loopback(u) {
			return fmt.Errorf("%q: plain http is accepted for localhost only", raw)
		}
	case slices.Contains([]string{"javascript", "data", "file", "blob", "about", "vbscript"}, u.Scheme):
		return fmt.Errorf("%q: the %s scheme is not accepted", raw, u.Scheme)
	}
	return nil
}

// sameRedirect compares a requested address with a registered one. A
// loopback address matches on any port, which the client picks when it
// starts to listen.
func sameRedirect(registered, requested string) bool {
	if registered == requested {
		return true
	}
	a, errA := url.Parse(registered)
	b, errB := url.Parse(requested)
	if errA != nil || errB != nil || !loopback(a) || !loopback(b) {
		return false
	}
	return a.Hostname() == b.Hostname() && a.Path == b.Path && a.RawQuery == b.RawQuery
}

// Request is an authorization request as the client put it in the address
// of the approval page.
type Request struct {
	ClientID            string `json:"client_id"`
	RedirectURI         string `json:"redirect_uri"`
	ResponseType        string `json:"response_type"`
	CodeChallenge       string `json:"code_challenge"`
	CodeChallengeMethod string `json:"code_challenge_method"`
	Scope               string `json:"scope"`
	State               string `json:"state"`
}

// Prompt is what the admin is asked to approve.
type Prompt struct {
	// Redirect is set instead of everything else when the request is one
	// only the client can mend: it is where to send the browser back with
	// the error.
	Redirect string `json:"redirect,omitempty"`

	ClientName string `json:"client_name,omitempty"`
	ClientURI  string `json:"client_uri,omitempty"`
	// RedirectURI is where the approval goes, which is what tells one
	// client from another: the name is only the client's word.
	RedirectURI string `json:"redirect_uri,omitempty"`
	// Scopes are the tools to offer ticked: those the client's key has, or
	// else those it asked for.
	Scopes []string `json:"scopes,omitempty"`
	// Key is the name of the key the client already calls with, if any.
	Key string `json:"key,omitempty"`
}

// errorRedirect is an error that goes back to the client.
type errorRedirect struct{ code, description string }

func (e *errorRedirect) Error() string { return e.description }

// check validates a request. An error that is not an errorRedirect must be
// shown to the admin, because the address to send it to is not trusted.
func (s *Server) check(ctx context.Context, req *Request) (store.OAuthClient, error) {
	if !s.enabled() {
		return store.OAuthClient{}, errors.New("signing in with OAuth is switched off on this server")
	}
	client, ok, err := s.app.Store.GetOAuthClient(ctx, req.ClientID)
	if err != nil {
		return client, err
	}
	if !ok {
		return client, errors.New("this client is not registered here; remove the server from the client and add it again")
	}
	if req.RedirectURI == "" && len(client.RedirectURIs) == 1 {
		req.RedirectURI = client.RedirectURIs[0]
	}
	if !slices.ContainsFunc(client.RedirectURIs, func(uri string) bool { return sameRedirect(uri, req.RedirectURI) }) {
		return client, errors.New("the client asked to be answered at an address it did not register")
	}
	switch {
	case req.ResponseType != "code":
		return client, &errorRedirect{"unsupported_response_type", "response_type must be code"}
	case req.CodeChallenge == "" || req.CodeChallengeMethod != "S256":
		return client, &errorRedirect{"invalid_request", "a code_challenge with code_challenge_method S256 is required"}
	}
	return client, nil
}

// answer is the address that takes the outcome of a request back to the client.
func answer(issuer string, req Request, params url.Values) string {
	u, err := url.Parse(req.RedirectURI)
	if err != nil {
		return ""
	}
	query := u.Query()
	for key, values := range params {
		query[key] = values
	}
	if req.State != "" {
		query.Set("state", req.State)
	}
	query.Set("iss", issuer)
	u.RawQuery = query.Encode()
	return u.String()
}

func refusal(issuer string, req Request, e *errorRedirect) string {
	return answer(issuer, req, url.Values{"error": {e.code}, "error_description": {e.description}})
}

// Describe returns what to ask the admin about a request.
func (s *Server) Describe(r *http.Request, req Request) (Prompt, error) {
	client, err := s.check(r.Context(), &req)
	var back *errorRedirect
	if errors.As(err, &back) {
		return Prompt{Redirect: refusal(s.issuer(r), req, back)}, nil
	}
	if err != nil {
		return Prompt{}, err
	}
	prompt := Prompt{ClientName: client.Name, ClientURI: client.URI, RedirectURI: req.RedirectURI}
	key, ok, err := s.app.Store.OAuthKey(r.Context(), client.ID)
	if err != nil {
		return Prompt{}, err
	}
	if ok {
		prompt.Key, prompt.Scopes = key.Name, key.Scopes
		return prompt, nil
	}
	for _, scope := range strings.Fields(req.Scope) {
		if slices.Contains(config.Tools, scope) && !slices.Contains(prompt.Scopes, scope) {
			prompt.Scopes = append(prompt.Scopes, scope)
		}
	}
	if len(prompt.Scopes) == 0 {
		prompt.Scopes = slices.Clone(config.Tools)
	}
	return prompt, nil
}

// Decide records the admin's answer to a request and returns the address
// that takes it to the client. scopes are the tools the client may call.
func (s *Server) Decide(r *http.Request, req Request, approve bool, scopes []string) (string, error) {
	client, err := s.check(r.Context(), &req)
	var back *errorRedirect
	switch {
	case errors.As(err, &back):
		return refusal(s.issuer(r), req, back), nil
	case err != nil:
		return "", err
	case !approve:
		return refusal(s.issuer(r), req, &errorRedirect{"access_denied", "the request was declined"}), nil
	}
	scopes = slices.DeleteFunc(slices.Clone(config.Tools), func(tool string) bool { return !slices.Contains(scopes, tool) })
	if len(scopes) == 0 {
		return "", errors.New("select at least one tool")
	}

	code := store.NewToken("")
	s.mu.Lock()
	for hash, pending := range s.codes {
		if time.Now().After(pending.expires) {
			delete(s.codes, hash)
		}
	}
	s.codes[store.HashToken(code)] = approval{
		client: client.ID, redirectURI: req.RedirectURI, challenge: req.CodeChallenge, scopes: scopes, expires: time.Now().Add(codeTTL),
	}
	s.mu.Unlock()
	return answer(s.issuer(r), req, url.Values{"code": {code}}), nil
}

// redeem takes an approval by its code, which works once.
func (s *Server) redeem(code string) (approval, bool) {
	hash := store.HashToken(code)
	s.mu.Lock()
	defer s.mu.Unlock()
	pending, ok := s.codes[hash]
	delete(s.codes, hash)
	return pending, ok && time.Now().Before(pending.expires)
}

// client identifies the caller of the token endpoint. A client that was
// given a secret must present it; a public one is held to PKCE alone.
func (s *Server) client(r *http.Request) (store.OAuthClient, bool) {
	id, secret := r.PostFormValue("client_id"), r.PostFormValue("client_secret")
	if user, pass, ok := r.BasicAuth(); ok {
		// RFC 6749 has both form-encoded inside the header.
		if decoded, err := url.QueryUnescape(user); err == nil {
			user = decoded
		}
		if decoded, err := url.QueryUnescape(pass); err == nil {
			pass = decoded
		}
		id, secret = user, pass
	}
	client, ok, err := s.app.Store.GetOAuthClient(r.Context(), id)
	if err != nil || !ok {
		return client, false
	}
	if client.SecretHash != "" && subtle.ConstantTimeCompare([]byte(store.HashToken(secret)), []byte(client.SecretHash)) != 1 {
		return client, false
	}
	return client, true
}

func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	if s.throttled(w, r, "token", config.RateLimit{Requests: 60, Window: time.Minute}) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	if err := r.ParseForm(); err != nil {
		fail(w, http.StatusBadRequest, "invalid_request", "the body must be form-encoded")
		return
	}
	client, ok := s.client(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Basic realm="seekmux"`)
		fail(w, http.StatusUnauthorized, "invalid_client", "unknown client or wrong client secret")
		return
	}

	var key store.APIKey
	switch r.PostFormValue("grant_type") {
	case "authorization_code":
		pending, ok := s.redeem(r.PostFormValue("code"))
		sum := sha256.Sum256([]byte(r.PostFormValue("code_verifier")))
		redirect := r.PostFormValue("redirect_uri")
		switch {
		case !ok || pending.client != client.ID:
			fail(w, http.StatusBadRequest, "invalid_grant", "the authorization code is unknown, used or expired")
			return
		case redirect != "" && redirect != pending.redirectURI:
			fail(w, http.StatusBadRequest, "invalid_grant", "redirect_uri is not the one the code was issued to")
			return
		case subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(pending.challenge)) != 1:
			fail(w, http.StatusBadRequest, "invalid_grant", "code_verifier does not match the code_challenge")
			return
		}
		var err error
		if key, err = s.keyFor(r.Context(), client, pending.scopes); err != nil {
			fail(w, http.StatusInternalServerError, "server_error", "the grant could not be stored")
			return
		}
	case "refresh_token":
		var err error
		key, ok, err = s.app.Store.RedeemRefreshToken(r.Context(), client.ID, r.PostFormValue("refresh_token"), refreshGrace)
		if err != nil {
			fail(w, http.StatusInternalServerError, "server_error", "the token could not be read")
			return
		}
		if !ok || key.Expired() {
			fail(w, http.StatusBadRequest, "invalid_grant", "the refresh token is unknown, expired or revoked; sign in again")
			return
		}
	default:
		fail(w, http.StatusBadRequest, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
		return
	}

	tokens, err := s.app.Store.IssueOAuthTokens(r.Context(), client.ID, key.ID, accessTTL, refreshTTL)
	if err != nil {
		fail(w, http.StatusInternalServerError, "server_error", "the tokens could not be stored")
		return
	}
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  tokens.Access,
		"token_type":    "Bearer",
		"expires_in":    int(tokens.ExpiresIn.Seconds()),
		"refresh_token": tokens.Refresh,
		"scope":         strings.Join(key.Scopes, " "),
	})
}

// keyFor returns the key a client calls with, limited to scopes. A client
// approved again keeps its key, and with it the usage, the limits and the
// policy the admin gave it.
func (s *Server) keyFor(ctx context.Context, client store.OAuthClient, scopes []string) (store.APIKey, error) {
	key, ok, err := s.app.Store.OAuthKey(ctx, client.ID)
	if err != nil {
		return key, err
	}
	if !ok {
		key, _, err = s.app.Store.CreateAPIKey(ctx, store.KeySpec{Name: client.Name, Scopes: scopes, OAuthClient: client.ID})
		return key, err
	}
	key.Scopes = scopes
	return key, s.app.Store.SetKeyScopes(ctx, key.ID, scopes)
}
