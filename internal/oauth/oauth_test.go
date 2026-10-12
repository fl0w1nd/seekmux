package oauth_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/fl0w1nd/seekmux/internal/app"
	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/mcpsrv"
	"github.com/fl0w1nd/seekmux/internal/oauth"
	"github.com/fl0w1nd/seekmux/internal/store"
)

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

type gateway struct {
	t     *testing.T
	app   *app.App
	authz *oauth.Server
	url   string
}

func start(t *testing.T) *gateway {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, err := app.New(context.Background(), st)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	authz := oauth.New(a)
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcpsrv.Handler(a, "test"))
	authz.Mount(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &gateway{t: t, app: a, authz: authz, url: srv.URL}
}

// json decodes the body of a response into a map and returns it with the status.
func (g *gateway) json(res *http.Response, err error) (int, map[string]any) {
	g.t.Helper()
	if err != nil {
		g.t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (g *gateway) register(metadata string) (int, map[string]any) {
	return g.json(http.Post(g.url+"/oauth/register", "application/json", strings.NewReader(metadata)))
}

func (g *gateway) token(form url.Values) (int, map[string]any) {
	return g.json(http.PostForm(g.url+"/oauth/token", form))
}

// approve has the admin answer a request and returns the query the client
// is sent back with.
func (g *gateway) approve(req oauth.Request, approve bool, scopes ...string) url.Values {
	g.t.Helper()
	r := httptest.NewRequest(http.MethodPost, g.url+"/api/oauth/decide", nil)
	redirect, err := g.authz.Decide(r, req, approve, scopes)
	if err != nil {
		g.t.Fatal(err)
	}
	u, err := url.Parse(redirect)
	if err != nil || !strings.HasPrefix(redirect, req.RedirectURI) {
		g.t.Fatalf("redirect = %q", redirect)
	}
	return u.Query()
}

// tools lists the tools a token is offered, or returns the challenge it is
// turned away with.
func (g *gateway) tools(token string) ([]string, string) {
	g.t.Helper()
	ctx := context.Background()
	req, _ := http.NewRequest(http.MethodPost, g.url+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		g.t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return nil, res.Header.Get("WWW-Authenticate")
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).
		Connect(ctx, &mcp.StreamableClientTransport{Endpoint: g.url + "/mcp", HTTPClient: &http.Client{Transport: bearer{token}}}, nil)
	if err != nil {
		g.t.Fatal(err)
	}
	defer session.Close()
	list, err := session.ListTools(ctx, nil)
	if err != nil {
		g.t.Fatal(err)
	}
	var names []string
	for _, tool := range list.Tools {
		names = append(names, tool.Name)
	}
	return names, ""
}

const verifier = "a-code-verifier-of-at-least-forty-three-characters"

func challenge() string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func TestAClientSignsInAndCallsWithItsTokens(t *testing.T) {
	g := start(t)
	ctx := context.Background()

	// Without a key the endpoint says where to sign in, and the metadata leads to the endpoints.
	_, challenged := g.tools("")
	if want := `resource_metadata="` + g.url + `/.well-known/oauth-protected-resource/mcp"`; !strings.Contains(challenged, want) {
		t.Fatalf("challenge = %q, want %s", challenged, want)
	}
	_, resource := g.json(http.Get(g.url + "/.well-known/oauth-protected-resource/mcp"))
	if resource["resource"] != g.url+"/mcp" || resource["authorization_servers"].([]any)[0] != g.url {
		t.Fatalf("resource metadata = %v", resource)
	}
	_, meta := g.json(http.Get(g.url + "/.well-known/oauth-authorization-server"))
	if meta["issuer"] != g.url || meta["token_endpoint"] != g.url+"/oauth/token" || meta["registration_endpoint"] != g.url+"/oauth/register" {
		t.Fatalf("server metadata = %v", meta)
	}

	status, client := g.register(`{"client_name":"Test\n Client","redirect_uris":["http://127.0.0.1:1234/callback"],"token_endpoint_auth_method":"none"}`)
	if status != http.StatusCreated || client["client_name"] != "Test Client" || client["client_secret"] != nil {
		t.Fatalf("registration = %d %v", status, client)
	}
	id := client["client_id"].(string)
	// A desktop client listens on a port of its choosing.
	req := oauth.Request{ClientID: id, RedirectURI: "http://127.0.0.1:5678/callback", ResponseType: "code", CodeChallenge: challenge(), CodeChallengeMethod: "S256", State: "xyz", Scope: "search fetch bogus"}

	prompt, err := g.authz.Describe(httptest.NewRequest(http.MethodPost, g.url, nil), req)
	if err != nil || prompt.ClientName != "Test Client" || strings.Join(prompt.Scopes, " ") != "search fetch" {
		t.Fatalf("prompt = %+v, %v", prompt, err)
	}
	if declined := g.approve(req, false); declined.Get("error") != "access_denied" || declined.Get("state") != "xyz" {
		t.Fatalf("declined = %v", declined)
	}

	answer := g.approve(req, true, "fetch", "search")
	if answer.Get("state") != "xyz" || answer.Get("iss") != g.url || answer.Get("code") == "" {
		t.Fatalf("answer = %v", answer)
	}
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {id}, "code": {answer.Get("code")}, "redirect_uri": {req.RedirectURI}}
	form.Set("code_verifier", "not-the-verifier")
	if status, body := g.token(form); status != http.StatusBadRequest || body["error"] != "invalid_grant" {
		t.Fatalf("wrong verifier = %d %v", status, body)
	}
	// The failed attempt used the code up.
	form.Set("code_verifier", verifier)
	if status, body := g.token(form); status != http.StatusBadRequest || body["error"] != "invalid_grant" {
		t.Fatalf("code used twice = %d %v", status, body)
	}

	form.Set("code", g.approve(req, true, "fetch", "search").Get("code"))
	status, tokens := g.token(form)
	if status != http.StatusOK || tokens["token_type"] != "Bearer" || tokens["scope"] != "search fetch" || tokens["expires_in"].(float64) != 3600 {
		t.Fatalf("tokens = %d %v", status, tokens)
	}
	access, refresh := tokens["access_token"].(string), tokens["refresh_token"].(string)
	if names, _ := g.tools(access); strings.Join(names, " ") != "fetch search" {
		t.Fatalf("tools = %v", names)
	}
	// The refresh token is no access token.
	if _, challenged := g.tools(refresh); !strings.Contains(challenged, `error="invalid_token"`) {
		t.Fatalf("refresh token as access token: %q", challenged)
	}

	// The client stands in the console as a key of its own.
	keys, _ := g.app.Store.ListAPIKeys(ctx)
	if len(keys) != 1 || keys[0].Name != "Test Client" || keys[0].OAuthClient != id {
		t.Fatalf("keys = %+v", keys)
	}

	status, renewed := g.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {id}, "refresh_token": {refresh}})
	if status != http.StatusOK || renewed["access_token"] == access || renewed["refresh_token"] == refresh {
		t.Fatalf("refresh = %d %v", status, renewed)
	}
	if names, _ := g.tools(renewed["access_token"].(string)); len(names) != 2 {
		t.Fatalf("tools after refresh = %v", names)
	}
	if status, body := g.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {"smc_other"}, "refresh_token": {renewed["refresh_token"].(string)}}); status != http.StatusUnauthorized || body["error"] != "invalid_client" {
		t.Fatalf("refresh by an unknown client = %d %v", status, body)
	}

	// Approved again with fewer tools, the client keeps its key.
	form.Set("code", g.approve(req, true, "search").Get("code"))
	if status, again := g.token(form); status != http.StatusOK || again["scope"] != "search" {
		t.Fatalf("second approval = %d %v", status, again)
	}
	if keys, _ := g.app.Store.ListAPIKeys(ctx); len(keys) != 1 || strings.Join(keys[0].Scopes, " ") != "search" {
		t.Fatalf("keys after the second approval = %+v", keys)
	}

	// Revoking the key signs the client out for good.
	if err := g.app.Store.RevokeAPIKey(ctx, keys[0].ID); err != nil {
		t.Fatal(err)
	}
	if names, _ := g.tools(renewed["access_token"].(string)); names != nil {
		t.Fatalf("a revoked client still lists %v", names)
	}
	if status, body := g.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {id}, "refresh_token": {renewed["refresh_token"].(string)}}); status != http.StatusBadRequest || body["error"] != "invalid_grant" {
		t.Fatalf("refresh after revoking = %d %v", status, body)
	}
}

func TestRequestsThatMustNotBeAnsweredToTheClient(t *testing.T) {
	g := start(t)
	for metadata, want := range map[string]string{
		`{"redirect_uris":[]}`:                                                                        "invalid_redirect_uri",
		`{"redirect_uris":["http://example.com/cb"]}`:                                                 "invalid_redirect_uri",
		`{"redirect_uris":["javascript:alert(1)"]}`:                                                   "invalid_redirect_uri",
		`{"redirect_uris":["https://example.com/cb#frag"]}`:                                           "invalid_redirect_uri",
		`{"redirect_uris":["https://example.com/cb"],"token_endpoint_auth_method":"private_key_jwt"}`: "invalid_client_metadata",
	} {
		if status, body := g.register(metadata); status != http.StatusBadRequest || body["error"] != want {
			t.Errorf("%s: %d %v, want %s", metadata, status, body, want)
		}
	}

	// A confidential client gets a secret and must present it.
	_, client := g.register(`{"redirect_uris":["https://example.com/cb","cursor://anysphere.cursor-mcp/oauth/callback"]}`)
	id, secret := client["client_id"].(string), client["client_secret"].(string)
	if secret == "" || client["token_endpoint_auth_method"] != "client_secret_basic" {
		t.Fatalf("registration = %v", client)
	}
	r := httptest.NewRequest(http.MethodPost, g.url, nil)
	req := oauth.Request{ClientID: id, RedirectURI: "https://evil.example/cb", ResponseType: "code", CodeChallenge: challenge(), CodeChallengeMethod: "S256"}
	if _, err := g.authz.Describe(r, req); err == nil {
		t.Error("an unregistered redirect_uri was accepted")
	}
	if _, err := g.authz.Decide(r, req, true, config.Tools); err == nil {
		t.Error("an unregistered redirect_uri was approved")
	}
	req.RedirectURI = "https://example.com/cb"
	req.CodeChallengeMethod = "plain"
	if prompt, err := g.authz.Describe(r, req); err != nil || !strings.Contains(prompt.Redirect, "error=invalid_request") {
		t.Errorf("a request without S256 = %+v, %v", prompt, err)
	}
	req.CodeChallengeMethod = "S256"
	code := g.approve(req, true, config.Tools...).Get("code")
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {id}, "code": {code}, "code_verifier": {verifier}}
	if status, body := g.token(form); status != http.StatusUnauthorized || body["error"] != "invalid_client" {
		t.Fatalf("without the secret = %d %v", status, body)
	}
	form.Set("client_secret", secret)
	if status, body := g.token(form); status != http.StatusOK {
		t.Fatalf("with the secret = %d %v", status, body)
	}

	// Switched off, nothing of it is left: no endpoints, no hint, no tokens.
	cfg := g.app.Snapshot().Config.Clone()
	cfg.OAuth.Disabled = true
	if err := g.app.SaveConfig(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if res, err := http.Get(g.url + "/.well-known/oauth-authorization-server"); err != nil || res.StatusCode != http.StatusNotFound {
		t.Errorf("metadata while switched off: %v %v", res.StatusCode, err)
	}
	if _, challenged := g.tools(""); strings.Contains(challenged, "resource_metadata") {
		t.Errorf("challenge while switched off = %q", challenged)
	}
}
