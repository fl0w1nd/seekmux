package worker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeWorker is the worker end of a connection, driven by the test.
type fakeWorker struct {
	t  *testing.T
	ws *websocket.Conn
}

func dial(t *testing.T, url string, hello Message) (*fakeWorker, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(url, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(readLimit)
	w := &fakeWorker{t: t, ws: ws}
	t.Cleanup(func() { ws.CloseNow() })
	w.send(hello)
	m, err := w.read()
	if err != nil {
		return nil, err
	}
	if m.Type != TypeWelcome {
		t.Fatalf("expected a welcome, got %+v", m)
	}
	return w, nil
}

func (w *fakeWorker) send(m Message) {
	data, _ := json.Marshal(m)
	if err := w.ws.Write(context.Background(), websocket.MessageText, data); err != nil {
		w.t.Fatal(err)
	}
}

func (w *fakeWorker) read() (Message, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := w.ws.Read(ctx)
	if err != nil {
		return Message{}, err
	}
	var m Message
	return m, json.Unmarshal(data, &m)
}

func ready(profiles ...string) *State {
	s := &State{Ready: true, Profiles: []Profile{}}
	for _, id := range profiles {
		s.Profiles = append(s.Profiles, Profile{ID: id, Connected: true})
	}
	return s
}

func hello(token string, state *State) Message {
	return Message{Type: TypeHello, Protocol: ProtocolVersion, Token: token, Version: "test", Slots: 1, State: state}
}

// tokens maps each token the hub accepts to its worker's id.
type tokens struct{ m atomic.Value }

func newTokens(pairs map[string]string) *tokens {
	t := &tokens{}
	t.m.Store(pairs)
	return t
}

func (t *tokens) lookup(token string) (string, bool) {
	id, ok := t.m.Load().(map[string]string)[token]
	return id, ok
}

func newHub(t *testing.T) (*Hub, *httptest.Server) {
	hub := &Hub{Lookup: newTokens(map[string]string{"secret": "w1"}).lookup}
	server := httptest.NewServer(hub)
	t.Cleanup(server.Close)
	return hub, server
}

// waitOnline waits for the hub to register a worker whose welcome the test
// has already read.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestHubRefusesAWrongToken(t *testing.T) {
	hub, server := newHub(t)
	_, err := dial(t, server.URL, hello("wrong", ready()))
	if websocket.CloseStatus(err) != CloseUnauthorized {
		t.Fatalf("err = %v", err)
	}
	_, err = dial(t, server.URL, hello("", ready()))
	if websocket.CloseStatus(err) != CloseUnauthorized {
		t.Fatalf("an empty token must be refused: %v", err)
	}
	if len(hub.Status()) != 0 {
		t.Fatal("a refused worker must not count as connected")
	}
}

func TestHubRefusesAnotherProtocol(t *testing.T) {
	_, server := newHub(t)
	m := hello("secret", ready())
	m.Protocol = ProtocolVersion + 1
	if _, err := dial(t, server.URL, m); websocket.CloseStatus(err) != CloseProtocol {
		t.Fatalf("err = %v", err)
	}
}

func TestHubFetchesThroughTheWorker(t *testing.T) {
	hub, server := newHub(t)
	if _, err := hub.Fetch(context.Background(), "w1", Request{URL: "https://x.com/a/status/1"}); !errors.Is(err, ErrOffline) {
		t.Fatalf("without a worker: %v", err)
	}
	w, err := dial(t, server.URL, hello("secret", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return hub.Online("w1") })

	go func() {
		m, err := w.read()
		if err != nil || m.Type != TypeFetch || !m.Adapter || m.Profile != "p1" || m.TimeoutMs <= 0 {
			t.Errorf("fetch = %+v, %v", m, err)
			return
		}
		w.send(Message{Type: TypeResult, ID: m.ID, Page: &Page{URL: m.URL, Title: "T", Content: "body", Source: "twitter"}})
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	page, err := hub.Fetch(ctx, "w1", Request{URL: "https://x.com/a/status/1", Adapter: true, Profile: "p1"})
	if err != nil || page.Content != "body" || page.Source != "twitter" {
		t.Fatalf("page = %+v, %v", page, err)
	}

	go func() {
		m, _ := w.read()
		w.send(Message{Type: TypeResult, ID: m.ID, Error: &Error{Code: CodeLoginRequired, Message: "Not logged in to x.com"}})
	}()
	_, err = hub.Fetch(ctx, "w1", Request{URL: "https://x.com/a/status/2"})
	var werr *Error
	if !errors.As(err, &werr) || werr.Code != CodeLoginRequired {
		t.Fatalf("err = %v", err)
	}
}

func TestHubChecksTheWorkerBeforeSending(t *testing.T) {
	hub, server := newHub(t)
	w, err := dial(t, server.URL, hello("secret", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return hub.Online("w1") })
	var werr *Error
	if _, err := hub.Fetch(context.Background(), "w1", Request{URL: "https://a.b", Profile: "gone"}); !errors.As(err, &werr) || werr.Code != CodeProfileMissing {
		t.Fatalf("an unknown profile: %v", err)
	}

	// The one slot is taken by a fetch the worker never answers.
	first := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		_, err := hub.Fetch(ctx, "w1", Request{URL: "https://a.b/1"})
		first <- err
	}()
	m, err := w.read()
	if err != nil || m.Type != TypeFetch {
		t.Fatalf("fetch = %+v, %v", m, err)
	}
	if _, err := hub.Fetch(context.Background(), "w1", Request{URL: "https://a.b/2"}); !errors.As(err, &werr) || werr.Code != CodeBusy {
		t.Fatalf("a full worker: %v", err)
	}
	// The caller leaving tells the worker to stop.
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("first = %v", err)
	}
	if c, err := w.read(); err != nil || c.Type != TypeCancel || c.ID != m.ID {
		t.Fatalf("cancel = %+v, %v", c, err)
	}

	w.send(Message{Type: TypeState, State: &State{Ready: false, Problem: "Browser Bridge extension not connected", Profiles: []Profile{}}})
	waitFor(t, func() bool { return !hub.Online("w1") })
	if _, err := hub.Fetch(context.Background(), "w1", Request{URL: "https://a.b"}); !errors.As(err, &werr) || werr.Code != CodeBrowserUnavailable || !strings.Contains(werr.Message, "extension") {
		t.Fatalf("a worker without its browser: %v", err)
	}
}

func TestHubFailsTheFetchesOfAWorkerThatLeaves(t *testing.T) {
	hub, server := newHub(t)
	w, err := dial(t, server.URL, hello("secret", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return hub.Online("w1") })
	done := make(chan error, 1)
	go func() {
		_, err := hub.Fetch(context.Background(), "w1", Request{URL: "https://a.b"})
		done <- err
	}()
	if _, err := w.read(); err != nil {
		t.Fatal(err)
	}
	w.ws.CloseNow()
	select {
	case err := <-done:
		if !errors.Is(err, ErrDisconnected) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the fetch must end when the worker leaves")
	}
	waitFor(t, func() bool { return len(hub.Status()) == 0 })
}

func TestANewWorkerReplacesTheOldOne(t *testing.T) {
	hub, server := newHub(t)
	old, err := dial(t, server.URL, hello("secret", ready()))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return hub.Online("w1") })
	m := hello("secret", ready())
	m.Version = "new"
	if _, err := dial(t, server.URL, m); err != nil {
		t.Fatal(err)
	}
	if _, err := old.read(); websocket.CloseStatus(err) != CloseReplaced {
		t.Fatalf("the old worker must be told it was replaced: %v", err)
	}
	waitFor(t, func() bool { return hub.Status()["w1"].Version == "new" })
}

// Changing the token takes the connected worker's access away at once.
func TestAChangedTokenDropsTheWorker(t *testing.T) {
	keys := newTokens(map[string]string{"secret": "w1"})
	hub := &Hub{Lookup: keys.lookup}
	server := httptest.NewServer(hub)
	t.Cleanup(server.Close)
	w, err := dial(t, server.URL, hello("secret", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return hub.Online("w1") })

	hub.Recheck() // unchanged: it stays
	if !hub.Online("w1") {
		t.Fatal("a worker with the current token must stay")
	}
	keys.m.Store(map[string]string{"rotated": "w1"})
	hub.Recheck()
	if _, err := w.read(); websocket.CloseStatus(err) != CloseUnauthorized {
		t.Fatalf("the worker must be told its token is gone: %v", err)
	}
	waitFor(t, func() bool { return !hub.Online("w1") })
}

// Before the token is checked, a frame larger than a hello is not read.
func TestHubReadsLittleBeforeTheToken(t *testing.T) {
	hub, server := newHub(t)
	m := hello("wrong", ready())
	m.Version = strings.Repeat("x", helloLimit)
	if _, err := dial(t, server.URL, m); websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatalf("an oversized hello: %v", err)
	}
	if hub.Online("w1") {
		t.Fatal("no worker must be connected")
	}
}

// Each worker has a connection of its own: a fetch goes to the one it names,
// and a worker connecting does not replace another.
func TestHubKeepsAConnectionPerWorker(t *testing.T) {
	hub := &Hub{Lookup: newTokens(map[string]string{"one": "w1", "two": "w2"}).lookup}
	server := httptest.NewServer(hub)
	t.Cleanup(server.Close)
	w1, err := dial(t, server.URL, hello("one", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	w2, err := dial(t, server.URL, hello("two", ready("p2")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return hub.Online("w1") && hub.Online("w2") })
	if hub.Online("w3") {
		t.Fatal("an unknown worker is online")
	}
	if _, err := hub.Fetch(context.Background(), "w3", Request{URL: "https://a.b"}); !errors.Is(err, ErrOffline) {
		t.Fatalf("an unknown worker: %v", err)
	}

	go func() {
		m, err := w2.read()
		if err != nil || m.Profile != "p2" {
			t.Errorf("w2 fetch = %+v, %v", m, err)
			return
		}
		w2.send(Message{Type: TypeResult, ID: m.ID, Page: &Page{URL: m.URL, Content: "from two", Source: "page"}})
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	page, err := hub.Fetch(ctx, "w2", Request{URL: "https://a.b", Profile: "p2"})
	if err != nil || page.Content != "from two" {
		t.Fatalf("page = %+v, %v", page, err)
	}
	status := hub.Status()
	if len(status) != 2 || status["w1"].State.Profiles[0].ID != "p1" || status["w2"].State.Profiles[0].ID != "p2" {
		t.Fatalf("status = %+v", status)
	}

	w1.ws.CloseNow()
	waitFor(t, func() bool { return !hub.Online("w1") })
	if !hub.Online("w2") {
		t.Fatal("one worker leaving took the other away")
	}
}

// A caller that gives up while its fetch is being sent leaves the worker
// connected: the connection is shared by every fetch of the worker.
func TestACanceledFetchKeepsTheWorkerConnected(t *testing.T) {
	hub, server := newHub(t)
	w, err := dial(t, server.URL, hello("secret", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return hub.Online("w1") })
	// The worker reads what it is sent, so that nothing waits on it.
	go func() {
		for {
			if _, _, err := w.ws.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	for i := range 300 {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, err := hub.Fetch(ctx, "w1", Request{URL: "https://a.b"})
			done <- err
		}()
		time.Sleep(time.Duration(i%7) * 10 * time.Microsecond)
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("fetch %d: %v", i, err)
		}
		if !hub.Online("w1") {
			t.Fatalf("the worker was disconnected by fetch %d", i)
		}
	}
}

func TestHubSearchNeedsTheFeature(t *testing.T) {
	hub, server := newHub(t)
	old, err := dial(t, server.URL, hello("secret", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return hub.Online("w1") })
	_, err = hub.Search(context.Background(), "w1", SearchRequest{Site: "x", Feature: FeatureXSearch, Query: "q", Limit: 5})
	var e *Error
	if !errors.As(err, &e) || e.Code != CodeOutdated || !strings.Contains(e.Message, "version test") {
		t.Fatalf("a worker without the feature must be refused as outdated, got %v", err)
	}
	if got := hub.Status()["w1"].Features; got == nil || len(got) != 0 {
		t.Fatalf("features of a worker that announced none = %#v, want an empty list", got)
	}
	_ = old.ws.Close(websocket.StatusNormalClosure, "")
	waitFor(t, func() bool { return !hub.Online("w1") })

	m := hello("secret", ready("p1"))
	m.Features = []string{FeatureXSearch}
	w, err := dial(t, server.URL, m)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return hub.Online("w1") })
	go func() {
		req, err := w.read()
		if err != nil || req.Type != TypeSearch || req.Site != "x" || req.Query != "mcp since:2026-11-01" || req.Sort != "latest" || req.Limit != 3 {
			w.send(Message{Type: TypeResult, ID: req.ID, Error: &Error{Code: CodeFailed, Message: "unexpected request"}})
			return
		}
		w.send(Message{Type: TypeResult, ID: req.ID, Posts: []Post{{ID: "1", URL: "https://x.com/a/status/1", Author: "a", Text: "hi", Likes: 2}}})
	}()
	posts, err := hub.Search(context.Background(), "w1", SearchRequest{Site: "x", Feature: FeatureXSearch, Query: "mcp since:2026-11-01", Sort: "latest", Limit: 3})
	if err != nil || len(posts) != 1 || posts[0].Author != "a" || posts[0].Likes != 2 {
		t.Fatalf("posts = %+v, err = %v", posts, err)
	}
	if got := hub.Status()["w1"].Features; len(got) != 1 || got[0] != FeatureXSearch {
		t.Fatalf("features = %v", got)
	}

	// A search that matched nothing is an answer, not an error.
	go func() {
		req, _ := w.read()
		w.send(Message{Type: TypeResult, ID: req.ID})
	}()
	posts, err = hub.Search(context.Background(), "w1", SearchRequest{Site: "x", Feature: FeatureXSearch, Query: "nothing", Limit: 3})
	if err != nil || len(posts) != 0 {
		t.Fatalf("posts = %+v, err = %v", posts, err)
	}
}
