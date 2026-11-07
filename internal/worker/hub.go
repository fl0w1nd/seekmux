package worker

import (
	"cmp"
	"context"
	"crypto/subtle"
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
	// ErrOffline reports that no worker is connected.
	ErrOffline = errors.New("no worker is connected")
	// ErrDisconnected reports a worker that went away during a fetch.
	ErrDisconnected = errors.New("the worker disconnected before it answered")
)

// Hub holds the one worker connection and hands it fetches.
type Hub struct {
	// Token returns the token a worker must present; empty refuses every
	// worker.
	Token func() string
	// Addr returns where a request came from.
	Addr func(*http.Request) string
	// OnState, when set, is told every state a worker reports.
	OnState func(State)

	mu   sync.Mutex
	conn *session
	seq  atomic.Uint64
}

type session struct {
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

func (h *Hub) current() *session {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.conn
}

// Online reports whether a worker is connected and its browser is reachable.
func (h *Hub) Online() bool {
	s := h.current()
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.Ready
}

// Status describes the connected worker.
func (h *Hub) Status() Status {
	s := h.current()
	if s == nil {
		return Status{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.state
	state.Profiles = append([]Profile{}, s.state.Profiles...)
	return Status{
		Connected: true, Version: s.version, Slots: s.slots, Active: len(s.pending),
		Addr: s.addr, Since: s.since.UnixMilli(), State: &state,
	}
}

// Close ends the connection of the current worker, for a server shutting down.
func (h *Hub) Close() {
	if s := h.current(); s != nil {
		_ = s.ws.Close(websocket.StatusGoingAway, "the server is shutting down")
	}
}

// Recheck drops the connected worker when the configured token no longer
// matches the one it signed in with: a changed or cleared token takes the
// old worker's access away at once, not at its next reconnect.
func (h *Hub) Recheck() {
	s := h.current()
	if s == nil || h.accepts(s.token) {
		return
	}
	slog.Info("worker dropped: the worker token was changed", "addr", s.addr)
	// Close waits for the worker's answer; saving the configuration does not.
	go s.ws.Close(CloseUnauthorized, "the worker token was changed or removed")
}

// accepts reports whether token is the configured worker token. No
// configured token accepts nothing.
func (h *Hub) accepts(token string) bool {
	want := ""
	if h.Token != nil {
		want = h.Token()
	}
	return want != "" && subtle.ConstantTimeCompare([]byte(want), []byte(token)) == 1
}

// Fetch has the worker read a page. A failure the worker reports is an
// *Error; one of the connection is ErrOffline or ErrDisconnected.
func (h *Hub) Fetch(ctx context.Context, req Request) (*Page, error) {
	s := h.current()
	if s == nil {
		return nil, ErrOffline
	}
	id := strconv.FormatUint(h.seq.Add(1), 36)
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
	s.pending[id] = reply
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
	}()

	timeout := time.Minute
	if deadline, ok := ctx.Deadline(); ok {
		// Leave the answer time to come back before the caller gives up.
		timeout = max(time.Until(deadline)-500*time.Millisecond, time.Second)
	}
	err := s.send(ctx, &Message{Type: TypeFetch, ID: id, URL: req.URL, Adapter: req.Adapter, Profile: req.Profile, TimeoutMs: timeout.Milliseconds()})
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
		_ = s.send(cancelCtx, &Message{Type: TypeCancel, ID: id})
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
// token. A worker that connects replaces the one before it.
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
	if !h.accepts(hello.Token) {
		slog.Warn("worker refused: wrong token", "addr", addr)
		_ = ws.Close(CloseUnauthorized, "the token is wrong, or no worker token is configured")
		return
	}

	ws.SetReadLimit(readLimit)

	s := &session{
		ws: ws, token: hello.Token, version: hello.Version, slots: min(max(hello.Slots, 1), MaxSlots), addr: addr,
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
	old := h.conn
	h.conn = s
	h.mu.Unlock()
	if old != nil {
		go old.ws.Close(CloseReplaced, "another worker connected with the same token")
	}
	// A token changed after the hello was checked may have been rechecked
	// before this session was registered; check again now that it is.
	h.Recheck()
	slog.Info("worker connected", "addr", addr, "version", hello.Version, "slots", s.slots, "ready", s.state.Ready)
	if hello.State != nil && h.OnState != nil {
		h.OnState(*hello.State)
	}

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
	if h.conn == s {
		h.conn = nil
	}
	h.mu.Unlock()
	close(s.done)
	slog.Info("worker disconnected", "addr", addr, "reason", err)
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
				if h.OnState != nil {
					h.OnState(*m.State)
				}
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
