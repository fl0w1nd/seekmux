package worker

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	// MaxSlots caps the fetches one worker runs at once: it drives a single
	// browser.
	MaxSlots     = 2
	helloTimeout = 10 * time.Second
	writeTimeout = 10 * time.Second
	pingInterval = 20 * time.Second
	// readLimit bounds one frame; a page is cut long before this.
	readLimit = 64 << 20
	// helloLimit bounds the frames read before the token is checked.
	helloLimit = 64 << 10
)

var (
	// ErrOffline reports that the worker is not connected.
	ErrOffline = errors.New("the worker is not connected")
	// ErrDisconnected reports a worker that went away during a fetch.
	ErrDisconnected = errors.New("the worker disconnected before it answered")
)

// Hub holds the connections of the workers, one per worker, and hands them
// fetches.
type Hub struct {
	// Lookup returns the id of the worker a token belongs to; false refuses
	// the token.
	Lookup func(token string) (id string, ok bool)
	// Addr returns where a request came from.
	Addr func(*http.Request) string

	mu    sync.Mutex
	conns map[string]*session
	seq   atomic.Uint64
}

type session struct {
	// id is the worker's, as Lookup found it by the token.
	id string
	ws *websocket.Conn
	// token is the one the worker signed in with, to drop it when the
	// configured token changes.
	token   string
	version string
	slots   int
	addr    string
	since   time.Time
	done    chan struct{}

	mu      sync.Mutex
	state   State
	pending map[string]chan *Message
}

// Request is a page to read through the worker.
type Request struct {
	URL     string
	Adapter bool
	Profile string
}

// Status describes the connected worker for the console.
type Status struct {
	Connected bool   `json:"connected"`
	Version   string `json:"version,omitempty"`
	Slots     int    `json:"slots,omitempty"`
	Active    int    `json:"active"`
	Addr      string `json:"addr,omitempty"`
	// Since is when it connected, in Unix milliseconds.
	Since int64  `json:"since,omitempty"`
	State *State `json:"state,omitempty"`
}

func (h *Hub) session(id string) *session {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.conns[id]
}

func (h *Hub) sessions() []*session {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]*session, 0, len(h.conns))
	for _, s := range h.conns {
		out = append(out, s)
	}
	return out
}

// Online reports whether the worker is connected and its browser is
// reachable.
func (h *Hub) Online(id string) bool {
	s := h.session(id)
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.Ready
}

// Status describes the connected workers, by id.
func (h *Hub) Status() map[string]Status {
	out := map[string]Status{}
	for _, s := range h.sessions() {
		s.mu.Lock()
		state := s.state
		state.Profiles = append([]Profile{}, s.state.Profiles...)
		out[s.id] = Status{
			Connected: true, Version: s.version, Slots: s.slots, Active: len(s.pending),
			Addr: s.addr, Since: s.since.UnixMilli(), State: &state,
		}
		s.mu.Unlock()
	}
	return out
}

// Close ends every worker's connection, for a server shutting down.
func (h *Hub) Close() {
	for _, s := range h.sessions() {
		_ = s.ws.Close(websocket.StatusGoingAway, "the server is shutting down")
	}
}

// Recheck drops each connected worker whose token no longer belongs to it:
// a changed token, or a removed worker, loses its access at once, not at its
// next reconnect.
func (h *Hub) Recheck() {
	for _, s := range h.sessions() {
		if id, ok := h.lookup(s.token); ok && id == s.id {
			continue
		}
		slog.Info("worker dropped: its token was changed or it was removed", "worker", s.id, "addr", s.addr)
		// Close waits for the worker's answer; saving the configuration does not.
		go s.ws.Close(CloseUnauthorized, "the worker token was changed, or the worker was removed")
	}
}

func (h *Hub) lookup(token string) (string, bool) {
	if h.Lookup == nil || token == "" {
		return "", false
	}
	return h.Lookup(token)
}

// Fetch has the worker with the given id read a page. A failure the worker
// reports is an *Error; one of the connection is ErrOffline or
// ErrDisconnected.
func (h *Hub) Fetch(ctx context.Context, id string, req Request) (*Page, error) {
	s := h.session(id)
	if s == nil {
		return nil, ErrOffline
	}
	rid := strconv.FormatUint(h.seq.Add(1), 36)
	reply := make(chan *Message, 1)
	s.mu.Lock()
	var refused *Error
	switch {
	case !s.state.Ready:
		refused = &Error{Code: CodeBrowserUnavailable, Message: cmp.Or(s.state.Problem, "the worker's browser is not reachable")}
	case s.state.Route(req.Profile) != nil:
		// Refused by the profiles the worker reported, not by what OpenCLI's
		// message says once it fails.
		refused = s.state.Route(req.Profile)
	case len(s.pending) >= s.slots:
		refused = &Error{Code: CodeBusy, Message: fmt.Sprintf("the worker is already running %d fetches", s.slots)}
	}
	if refused != nil {
		s.mu.Unlock()
		return nil, refused
	}
	s.pending[rid] = reply
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, rid)
		s.mu.Unlock()
	}()

	timeout := time.Minute
	if deadline, ok := ctx.Deadline(); ok {
		// Leave the answer time to come back before the caller gives up.
		timeout = max(time.Until(deadline)-500*time.Millisecond, time.Second)
	}
	err := s.send(ctx, &Message{Type: TypeFetch, ID: rid, URL: req.URL, Adapter: req.Adapter, Profile: req.Profile, TimeoutMs: timeout.Milliseconds()})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrDisconnected
	}
	select {
	case m := <-reply:
		switch {
		case m.Error != nil:
			return nil, m.Error
		case m.Page == nil:
			return nil, &Error{Code: CodeInternal, Message: "the worker answered with neither a page nor an error"}
		}
		return m.Page, nil
	case <-ctx.Done():
		cancelCtx, cancel := context.WithTimeout(context.Background(), writeTimeout)
		defer cancel()
		_ = s.send(cancelCtx, &Message{Type: TypeCancel, ID: rid})
		return nil, ctx.Err()
	case <-s.done:
		return nil, ErrDisconnected
	}
}

func (s *session) send(ctx context.Context, m *Message) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return s.ws.Write(ctx, websocket.MessageText, data)
}

func (s *session) setState(st State) {
	if st.Profiles == nil {
		st.Profiles = []Profile{}
	}
	s.mu.Lock()
	s.state = st
	s.mu.Unlock()
}

// ServeHTTP accepts a worker: the first frame must be a hello with the
// token. A worker that connects replaces the one before it with the same
// id.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	// Until the token is checked, only a hello's worth is read.
	ws.SetReadLimit(helloLimit)
	addr := r.RemoteAddr
	if h.Addr != nil {
		addr = h.Addr(r)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	helloCtx, cancelHello := context.WithTimeout(ctx, helloTimeout)
	_, data, err := ws.Read(helloCtx)
	cancelHello()
	if err != nil {
		ws.CloseNow()
		return
	}
	var hello Message
	if json.Unmarshal(data, &hello) != nil || hello.Type != TypeHello {
		_ = ws.Close(CloseProtocol, "the first frame must be a hello")
		return
	}
	if hello.Protocol != ProtocolVersion {
		_ = ws.Close(CloseProtocol, fmt.Sprintf("this server speaks protocol %d, the worker %d: update the one that is older", ProtocolVersion, hello.Protocol))
		return
	}
	id, ok := h.lookup(hello.Token)
	if !ok {
		slog.Warn("worker refused: wrong token", "addr", addr)
		_ = ws.Close(CloseUnauthorized, "no worker on the gateway has this token")
		return
	}

	ws.SetReadLimit(readLimit)

	s := &session{
		id: id, ws: ws, token: hello.Token, version: hello.Version, slots: min(max(hello.Slots, 1), MaxSlots), addr: addr,
		since: time.Now(), done: make(chan struct{}), pending: map[string]chan *Message{},
	}
	if hello.State != nil {
		s.setState(*hello.State)
	}
	if err := s.send(ctx, &Message{Type: TypeWelcome}); err != nil {
		ws.CloseNow()
		return
	}
	h.mu.Lock()
	if h.conns == nil {
		h.conns = map[string]*session{}
	}
	old := h.conns[id]
	h.conns[id] = s
	h.mu.Unlock()
	if old != nil {
		go old.ws.Close(CloseReplaced, "another worker connected with the same token")
	}
	// A token changed after the hello was checked may have been rechecked
	// before this session was registered; check again now that it is.
	h.Recheck()
	slog.Info("worker connected", "worker", id, "addr", addr, "version", hello.Version, "slots", s.slots, "ready", s.state.Ready)

	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pingCtx, cancelPing := context.WithTimeout(ctx, writeTimeout)
				err := ws.Ping(pingCtx)
				cancelPing()
				if err != nil {
					ws.CloseNow()
					return
				}
			}
		}
	}()

	err = h.read(ctx, s)
	h.mu.Lock()
	if h.conns[id] == s {
		delete(h.conns, id)
	}
	h.mu.Unlock()
	close(s.done)
	slog.Info("worker disconnected", "worker", id, "addr", addr, "reason", err)
	ws.CloseNow()
}

func (h *Hub) read(ctx context.Context, s *session) error {
	for {
		_, data, err := s.ws.Read(ctx)
		if err != nil {
			return err
		}
		var m Message
		if err := json.Unmarshal(data, &m); err != nil {
			slog.Warn("worker sent a frame that is not JSON", "err", err)
			continue
		}
		switch m.Type {
		case TypeState:
			if m.State != nil {
				s.setState(*m.State)
			}
		case TypeResult:
			s.mu.Lock()
			reply := s.pending[m.ID]
			s.mu.Unlock()
			if reply != nil {
				select {
				case reply <- &m:
				default:
				}
			}
		}
	}
}
