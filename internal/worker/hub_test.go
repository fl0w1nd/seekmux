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

func newHub(t *testing.T) (*Hub, *httptest.Server) {
	hub := &Hub{Token: func() string { return "secret" }}
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
	hub.Token = func() string { return "" }
	_, err = dial(t, server.URL, hello("", ready()))
	if websocket.CloseStatus(err) != CloseUnauthorized {
		t.Fatalf("no configured token must refuse every worker: %v", err)
	}
	if hub.Status().Connected {
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
	if _, err := hub.Fetch(context.Background(), Request{URL: "https://x.com/a/status/1"}); !errors.Is(err, ErrOffline) {
		t.Fatalf("without a worker: %v", err)
	}
	w, err := dial(t, server.URL, hello("secret", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, hub.Online)

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
	page, err := hub.Fetch(ctx, Request{URL: "https://x.com/a/status/1", Adapter: true, Profile: "p1"})
	if err != nil || page.Content != "body" || page.Source != "twitter" {
		t.Fatalf("page = %+v, %v", page, err)
	}

	go func() {
		m, _ := w.read()
		w.send(Message{Type: TypeResult, ID: m.ID, Error: &Error{Code: CodeLoginRequired, Message: "Not logged in to x.com"}})
	}()
	_, err = hub.Fetch(ctx, Request{URL: "https://x.com/a/status/2"})
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
	waitFor(t, hub.Online)
	var werr *Error
	if _, err := hub.Fetch(context.Background(), Request{URL: "https://a.b", Profile: "gone"}); !errors.As(err, &werr) || werr.Code != CodeProfileMissing {
		t.Fatalf("an unknown profile: %v", err)
	}

	// The one slot is taken by a fetch the worker never answers.
	first := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		_, err := hub.Fetch(ctx, Request{URL: "https://a.b/1"})
		first <- err
	}()
	m, err := w.read()
	if err != nil || m.Type != TypeFetch {
		t.Fatalf("fetch = %+v, %v", m, err)
	}
	if _, err := hub.Fetch(context.Background(), Request{URL: "https://a.b/2"}); !errors.As(err, &werr) || werr.Code != CodeBusy {
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
	waitFor(t, func() bool { return !hub.Online() })
	if _, err := hub.Fetch(context.Background(), Request{URL: "https://a.b"}); !errors.As(err, &werr) || werr.Code != CodeBrowserUnavailable || !strings.Contains(werr.Message, "extension") {
		t.Fatalf("a worker without its browser: %v", err)
	}
}

func TestHubFailsTheFetchesOfAWorkerThatLeaves(t *testing.T) {
	hub, server := newHub(t)
	w, err := dial(t, server.URL, hello("secret", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, hub.Online)
	done := make(chan error, 1)
	go func() {
		_, err := hub.Fetch(context.Background(), Request{URL: "https://a.b"})
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
	waitFor(t, func() bool { return !hub.Status().Connected })
}

func TestANewWorkerReplacesTheOldOne(t *testing.T) {
	hub, server := newHub(t)
	old, err := dial(t, server.URL, hello("secret", ready()))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, hub.Online)
	m := hello("secret", ready())
	m.Version = "new"
	if _, err := dial(t, server.URL, m); err != nil {
		t.Fatal(err)
	}
	if _, err := old.read(); websocket.CloseStatus(err) != CloseReplaced {
		t.Fatalf("the old worker must be told it was replaced: %v", err)
	}
	waitFor(t, func() bool { return hub.Status().Version == "new" })
}

// Changing the token takes the connected worker's access away at once.
func TestAChangedTokenDropsTheWorker(t *testing.T) {
	var token atomic.Value
	token.Store("secret")
	hub := &Hub{Token: func() string { return token.Load().(string) }}
	server := httptest.NewServer(hub)
	t.Cleanup(server.Close)
	w, err := dial(t, server.URL, hello("secret", ready("p1")))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, hub.Online)

	hub.Recheck() // unchanged: it stays
	if !hub.Online() {
		t.Fatal("a worker with the current token must stay")
	}
	token.Store("rotated")
	hub.Recheck()
	if _, err := w.read(); websocket.CloseStatus(err) != CloseUnauthorized {
		t.Fatalf("the worker must be told its token is gone: %v", err)
	}
	waitFor(t, func() bool { return !hub.Online() })
}

// Before the token is checked, a frame larger than a hello is not read.
func TestHubReadsLittleBeforeTheToken(t *testing.T) {
	hub, server := newHub(t)
	m := hello("wrong", ready())
	m.Version = strings.Repeat("x", helloLimit)
	if _, err := dial(t, server.URL, m); websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatalf("an oversized hello: %v", err)
	}
	if hub.Online() {
		t.Fatal("no worker must be connected")
	}
}
