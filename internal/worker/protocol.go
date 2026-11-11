// Package worker lets a machine elsewhere read pages for the gateway: it
// dials in over a WebSocket and keeps the connection open, and fetches that
// the ordinary providers cannot serve are handed to it. The worker itself is
// the npm package in worker/ (npx seekmux), which drives a logged-in Chrome
// through OpenCLI.
//
// Every frame is one JSON Message. The worker speaks first:
//
//	worker → server  hello   {protocol, token, version, slots, features, state}
//	server → worker  welcome {}                    or a close frame (see Close*)
//	worker → server  state   {state}               whenever it changes
//	server → worker  fetch   {id, url, adapter, profile, timeout_ms}
//	server → worker  search  {id, site, query, sort, limit, profile, timeout_ms}
//	server → worker  cancel  {id}                  the caller left
//	worker → server  result  {id, page}, {id, posts} or {id, error}
//
// A search is only sent to a worker whose hello announced the feature for
// its site (FeatureXSearch); a worker from before searches announces none.
package worker

import (
	"fmt"
	"slices"
)

// ProtocolVersion changes when either side could misread the other.
const ProtocolVersion = 1

// Message types.
const (
	TypeHello   = "hello"
	TypeWelcome = "welcome"
	TypeState   = "state"
	TypeFetch   = "fetch"
	TypeSearch  = "search"
	TypeCancel  = "cancel"
	TypeResult  = "result"
)

// FeatureXSearch is announced by a worker that searches X (TypeSearch with
// site "x").
const FeatureXSearch = "x_search"

// Close codes the server ends a connection with, besides the standard ones.
const (
	// CloseUnauthorized: the token is wrong, or no worker is configured.
	CloseUnauthorized = 4401
	// CloseProtocol: the first frame was not a hello this server understands.
	CloseProtocol = 4400
	// CloseReplaced: another worker connected with the same token.
	CloseReplaced = 4409
)

// Message is every frame of the protocol; Type says which fields are set.
type Message struct {
	Type string `json:"type"`

	// hello
	Protocol int    `json:"protocol,omitempty"`
	Token    string `json:"token,omitempty"`
	Version  string `json:"version,omitempty"`
	// Slots is how many fetches the worker runs at once.
	Slots int `json:"slots,omitempty"`
	// Features lists what the worker can do beyond reading pages.
	Features []string `json:"features,omitempty"`

	// hello, state
	State *State `json:"state,omitempty"`

	// fetch, cancel, result
	ID string `json:"id,omitempty"`

	// fetch
	URL string `json:"url,omitempty"`
	// Adapter asks for the site's own adapter when there is one, as a
	// routing rule does; without it, or without an adapter, the page is read
	// as it renders.
	Adapter bool `json:"adapter,omitempty"`
	// Profile is the Chrome profile to read with, by its OpenCLI context id;
	// empty leaves it to OpenCLI.
	Profile   string `json:"profile,omitempty"`
	TimeoutMs int64  `json:"timeout_ms,omitempty"`

	// search
	Site  string `json:"site,omitempty"`
	Query string `json:"query,omitempty"`
	// Sort is "top" or "latest".
	Sort  string `json:"sort,omitempty"`
	Limit int    `json:"limit,omitempty"`

	// result: a page for a fetch, posts for a search (none when nothing
	// matched), or an error.
	Page  *Page  `json:"page,omitempty"`
	Posts []Post `json:"posts,omitempty"`
	Error *Error `json:"error,omitempty"`
}

// Post is a post a search found.
type Post struct {
	ID     string `json:"id"`
	URL    string `json:"url"`
	Author string `json:"author"`
	// Name is the author's display name, when the site gave it.
	Name string `json:"name,omitempty"`
	Text string `json:"text"`
	// CreatedAt is in RFC 3339, or as the site wrote it when it could not
	// be read.
	CreatedAt string   `json:"created_at,omitempty"`
	Likes     int64    `json:"likes"`
	Reposts   int64    `json:"reposts"`
	Replies   int64    `json:"replies"`
	Views     int64    `json:"views,omitempty"`
	Media     []string `json:"media,omitempty"`
	Quoted    *Post    `json:"quoted,omitempty"`
}

// State is what the worker reports about its browser.
type State struct {
	// Ready means OpenCLI reaches a browser through its extension.
	Ready bool `json:"ready"`
	// Problem says why it is not ready.
	Problem  string    `json:"problem,omitempty"`
	OpenCLI  string    `json:"opencli,omitempty"`
	Profiles []Profile `json:"profiles"`
}

// Profile is a Chrome profile OpenCLI knows.
type Profile struct {
	ID        string `json:"id"`
	Alias     string `json:"alias,omitempty"`
	Default   bool   `json:"default,omitempty"`
	Connected bool   `json:"connected"`
}

// Has reports whether the worker knows the profile, connected or not.
func (s *State) Has(profile string) bool {
	for _, p := range s.Profiles {
		if p.ID == profile {
			return true
		}
	}
	return false
}

// Route says which profile OpenCLI reads with when profile is chosen (empty:
// none), following OpenCLI's own rule: a chosen profile must be connected;
// without one, the default is used, else the only connected profile.
//
// A chosen profile the worker does not know, or several connected profiles
// and none chosen, is a setup problem (CodeProfileMissing) that waits for the
// user. A known profile whose Chrome is closed, or no profile connected at
// all, is the browser being unavailable for now.
func (s *State) Route(profile string) *Error {
	var connected []Profile
	for _, p := range s.Profiles {
		if p.Connected {
			connected = append(connected, p)
		}
	}
	switch {
	case profile != "" && !s.Has(profile):
		return &Error{Code: CodeProfileMissing, Message: fmt.Sprintf("OpenCLI on the worker does not know the Chrome profile %q", profile)}
	case profile != "" && !slices.ContainsFunc(connected, func(p Profile) bool { return p.ID == profile }):
		return &Error{Code: CodeBrowserUnavailable, Message: fmt.Sprintf("the Chrome profile %q is not open on the worker", profile)}
	case profile != "":
		return nil
	case len(connected) > 1 && !slices.ContainsFunc(connected, func(p Profile) bool { return p.Default }):
		return &Error{Code: CodeProfileMissing, Message: fmt.Sprintf("%d Chrome profiles are connected and none is chosen: choose one for OpenCLI in the console", len(connected))}
	case len(connected) == 0:
		return &Error{Code: CodeBrowserUnavailable, Message: "no Chrome profile is connected to OpenCLI on the worker"}
	}
	return nil
}

// Page is a page the worker read.
type Page struct {
	URL     string `json:"url"`
	Title   string `json:"title,omitempty"`
	Content string `json:"content"`
	// Source names what read it: an adapter ("twitter", "reddit") or "page".
	Source string `json:"source"`
}

// Error codes of a failed fetch. The first group is about the page and
// moves on to the next provider; the second is about the worker.
const (
	// The site turned the profile away: not logged in, a login wall.
	CodeLoginRequired = "login_required"
	// The site says the page does not exist, or it was deleted.
	CodeNotFound = "not_found"
	// The site refused or limited the request.
	CodeBlocked = "blocked"
	// The page rendered but nothing could be read from it.
	CodeEmpty = "empty"
	// Reading the page took longer than the fetch allowed.
	CodeTimeout = "timeout"
	// Any other failure to read the page.
	CodeFailed = "failed"

	// The chosen Chrome profile is not known to OpenCLI on the worker.
	CodeProfileMissing = "profile_missing"
	// OpenCLI could not reach a browser: no extension, profile closed, no daemon.
	CodeBrowserUnavailable = "browser_unavailable"
	// Every slot of the worker is taken.
	CodeBusy = "busy"
	// The worker is too old for the request: it did not announce the
	// feature.
	CodeOutdated = "outdated"
	// The worker failed in a way that says nothing about the page.
	CodeInternal = "internal"
)

// Error is a failed fetch or search as the worker reports it.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	// Status is the site's HTTP status, when the worker learned it.
	Status int `json:"status,omitempty"`
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }
