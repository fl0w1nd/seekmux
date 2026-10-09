// Package admin serves the WebUI and its management API. It is authorized by
// an admin password and session cookie, separate from the API keys that
// authorize MCP calls.
package admin

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"

	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/store"
)

const (
	passwordKey   = "admin_password"
	sessionCookie = "seekmux_session"
	sessionTTL    = 30 * 24 * time.Hour
	minPassword   = 10

	// OWASP's minimum argon2id parameters; the memory cost is kept low for
	// small servers.
	argonTime    = 2
	argonMemory  = 19 * 1024
	argonThreads = 1
	argonKeyLen  = 32
)

func hashPassword(password string) string {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		panic(err)
	}
	hash := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("argon2id$%d$%d$%d$%s$%s", argonTime, argonMemory, argonThreads, enc.EncodeToString(salt), enc.EncodeToString(hash))
}

func verifyPassword(encoded, password string) bool {
	var t, m uint32
	var p uint8
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "argon2id" {
		return false
	}
	if _, err := fmt.Sscanf(strings.Join(parts[1:4], " "), "%d %d %d", &t, &m, &p); err != nil {
		return false
	}
	enc := base64.RawStdEncoding
	salt, err1 := enc.DecodeString(parts[4])
	want, err2 := enc.DecodeString(parts[5])
	if err1 != nil || err2 != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// InitPassword prepares the admin login on startup. A password from the
// environment always wins; without one, a first run prints a setup token that
// lets whoever holds the server log choose the password in the WebUI.
func (s *Server) InitPassword(ctx context.Context, envPassword string) error {
	if envPassword != "" {
		if len(envPassword) < minPassword {
			return fmt.Errorf("SEEKMUX_ADMIN_PASSWORD must be at least %d characters", minPassword)
		}
		stored, err := s.app.Store.Get(ctx, passwordKey)
		if err != nil || verifyPassword(string(stored), envPassword) {
			return err
		}
		// A new password signs everyone out, as changing it in the WebUI does.
		if err := s.app.Store.Set(ctx, passwordKey, []byte(hashPassword(envPassword))); err != nil {
			return err
		}
		return s.app.Store.DeleteSessions(ctx, "")
	}
	stored, err := s.app.Store.Get(ctx, passwordKey)
	if err != nil {
		return err
	}
	if stored == nil {
		s.setupToken = store.NewToken("setup_")
		slog.Warn("no admin password is set; open the WebUI and finish setup with this token", "setup_token", s.setupToken)
	}
	return nil
}

func (s *Server) passwordHash(ctx context.Context) string {
	stored, _ := s.app.Store.Get(ctx, passwordKey)
	return string(stored)
}

func (s *Server) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil || cookie.Value == "" {
		return false
	}
	ok, _ := s.app.Store.SessionValid(r.Context(), store.HashToken(cookie.Value))
	return ok
}

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authenticated(r) {
			writeError(w, http.StatusUnauthorized, errors.New("not signed in"))
			return
		}
		next(w, r)
	}
}

func secureRequest(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request) error {
	token := store.NewToken("")
	if err := s.app.Store.CreateSession(r.Context(), store.HashToken(token), sessionTTL); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: secureRequest(r),
	})
	return nil
}

// clientAddr is the address to hold a request against. Behind a reverse proxy
// every connection comes from the proxy, so when the peer is on a loopback or
// private network the last X-Forwarded-For entry, the one the proxy itself
// added, is used; from a public peer the header would be the client's word.
func clientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || !(peer.IsLoopback() || peer.IsPrivate()) {
		return host
	}
	forwarded := r.Header.Values("X-Forwarded-For")
	if len(forwarded) == 0 {
		return host
	}
	parts := strings.Split(forwarded[len(forwarded)-1], ",")
	if addr, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
		return addr.String()
	}
	return host
}

// throttle slows password guessing: ten attempts a minute per client address.
func (s *Server) throttle(w http.ResponseWriter, r *http.Request) bool {
	ok, wait := s.app.Limits.Rate.TryAcquire("login:"+clientAddr(r), config.RateLimit{Requests: 10, Window: time.Minute})
	if !ok {
		w.Header().Set("Retry-After", fmt.Sprint(int(wait.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, errors.New("too many attempts, try again in a minute"))
	}
	return ok
}

func (s *Server) handleAuthState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{
		"setup_required": s.passwordHash(r.Context()) == "",
		"authenticated":  s.authenticated(r),
	})
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !s.throttle(w, r) || !readJSON(w, r, &body) {
		return
	}
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	if s.passwordHash(r.Context()) != "" || s.setupToken == "" {
		writeError(w, http.StatusConflict, errors.New("setup is already done"))
		return
	}
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(body.Token)), []byte(s.setupToken)) != 1 {
		writeError(w, http.StatusForbidden, errors.New("wrong setup token; it is printed in the server log at startup"))
		return
	}
	if len(body.Password) < minPassword {
		writeError(w, http.StatusBadRequest, fmt.Errorf("the password must be at least %d characters", minPassword))
		return
	}
	if err := s.app.Store.Set(r.Context(), passwordKey, []byte(hashPassword(body.Password))); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	s.setupToken = ""
	if err := s.startSession(w, r); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if !s.throttle(w, r) || !readJSON(w, r, &body) {
		return
	}
	if hash := s.passwordHash(r.Context()); hash == "" || !verifyPassword(hash, body.Password) {
		writeError(w, http.StatusUnauthorized, errors.New("wrong password"))
		return
	}
	if err := s.startSession(w, r); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		_ = s.app.Store.DeleteSession(r.Context(), store.HashToken(cookie.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handlePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !s.throttle(w, r) || !readJSON(w, r, &body) {
		return
	}
	if !verifyPassword(s.passwordHash(r.Context()), body.Current) {
		writeError(w, http.StatusForbidden, errors.New("the current password is wrong"))
		return
	}
	if len(body.New) < minPassword {
		writeError(w, http.StatusBadRequest, fmt.Errorf("the password must be at least %d characters", minPassword))
		return
	}
	if err := s.app.Store.Set(r.Context(), passwordKey, []byte(hashPassword(body.New))); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// Changing the password signs every other browser out.
	keep := ""
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		keep = store.HashToken(cookie.Value)
	}
	_ = s.app.Store.DeleteSessions(r.Context(), keep)
	writeJSON(w, map[string]bool{"ok": true})
}
