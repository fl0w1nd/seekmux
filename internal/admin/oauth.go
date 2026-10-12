package admin

import (
	"net/http"

	"github.com/fl0w1nd/seekmux/internal/oauth"
)

// handleOAuthDescribe tells the approval page what an MCP client asks for.
func (s *Server) handleOAuthDescribe(w http.ResponseWriter, r *http.Request) {
	var body oauth.Request
	if !readJSON(w, r, &body) {
		return
	}
	prompt, err := s.oauth.Describe(r, body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, prompt)
}

// handleOAuthDecide takes the admin's answer and returns where to send the
// browser with it.
func (s *Server) handleOAuthDecide(w http.ResponseWriter, r *http.Request) {
	var body struct {
		oauth.Request
		Approve bool     `json:"approve"`
		Scopes  []string `json:"scopes"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	redirect, err := s.oauth.Decide(r, body.Request, body.Approve, body.Scopes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, map[string]string{"redirect": redirect})
}
