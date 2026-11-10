package admin

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/fl0w1nd/seekmux/internal/app"
	"github.com/fl0w1nd/seekmux/internal/config"
	"github.com/fl0w1nd/seekmux/internal/core"
	"github.com/fl0w1nd/seekmux/internal/oauth"
	"github.com/fl0w1nd/seekmux/internal/store"
)

func liveServer(t *testing.T) (*app.App, string) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	a, err := app.New(context.Background(), st)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	if err := st.CreateSession(context.Background(), store.HashToken("test-admin"), time.Hour); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(a, oauth.New(a), "test", fstest.MapFS{}).Handler())
	t.Cleanup(server.Close)
	return a, server.URL
}
func liveRequest(t *testing.T, method, url, body, accept string) *http.Response {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: "test-admin"})
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestPlayStreams(t *testing.T) {
	for _, tool := range []string{"search", "dev_search", "fetch"} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%v", tool, stream), func(t *testing.T) {
				a, base := liveServer(t)
				gate := make(chan struct{})
				var once sync.Once
				release := func() { once.Do(func() { close(gate) }) }
				defer release()
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					select {
					case <-gate:
					case <-r.Context().Done():
						return
					}
					reply := `{"data":{"title":"Fake","content":"Fake page"}}`
					if tool == "search" {
						reply = `{"web":{"results":[{"title":"Fake","url":"https://example.test/a","description":"result"}]}}`
					}
					if tool == "dev_search" {
						reply = `{"results":[{"type":"doc","url":"https://example.test/a","passages":[{"text":"result"}]}]}`
					}
					_, _ = w.Write([]byte(reply))
				}))
				defer upstream.Close()
				cfg := a.Snapshot().Config.Clone()
				cfg.Search.Routes = []config.Route{{Provider: "brave", Enabled: true}}
				cfg.DevSearch.Routes = []config.Route{{Provider: "firecrawl", Enabled: true}}
				cfg.Fetch.Routes = []config.Route{{Provider: "jina", Enabled: true}}
				for _, id := range []string{"brave", "firecrawl", "jina"} {
					cfg.Providers[id].APIKey = "fake-secret"
					cfg.Providers[id].BaseURL = upstream.URL
				}
				if err := a.SaveConfig(context.Background(), cfg); err != nil {
					t.Fatal(err)
				}
				body := `{"url":"https://example.test/page","raw":true,"no_cache":false}`
				if tool == "search" {
					body = `{"queries":["fake query"]}`
				}
				if tool == "dev_search" {
					body = `{"query":"fake query","search_engine":"firecrawl"}`
				}
				accept := ""
				if stream {
					accept = "application/x-ndjson"
				} else {
					release()
				}
				res := liveRequest(t, "POST", base+"/api/play/"+tool, body, accept)
				if res.StatusCode != 200 {
					b, _ := io.ReadAll(res.Body)
					t.Fatalf("status=%d body=%s", res.StatusCode, b)
				}
				decoder := json.NewDecoder(res.Body)
				var result map[string]json.RawMessage
				if stream {
					if !strings.HasPrefix(res.Header.Get("Content-Type"), "application/x-ndjson") {
						t.Fatalf("type=%s", res.Header.Get("Content-Type"))
					}
					var first map[string]string
					if err := decoder.Decode(&first); err != nil || !strings.HasPrefix(first["call_id"], "c_") || len(first) != 1 {
						t.Fatalf("first=%v err=%v", first, err)
					}
					// A running attempt arrives before the fake provider is released.
					for {
						var line struct {
							Node *core.Node `json:"node"`
						}
						if err := decoder.Decode(&line); err != nil {
							t.Fatal(err)
						}
						if line.Node != nil && line.Node.Kind == "attempt" && line.Node.Status == "running" {
							break
						}
					}
					release()
					for {
						var line map[string]json.RawMessage
						if err := decoder.Decode(&line); err != nil {
							t.Fatal(err)
						}
						if raw, ok := line["result"]; ok {
							if err := json.Unmarshal(raw, &result); err != nil {
								t.Fatal(err)
							}
							break
						}
						if _, node := line["node"]; !node {
							if _, text := line["text"]; !text {
								t.Fatalf("unexpected line=%s", line)
							}
						}
					}
					var tail any
					if err := decoder.Decode(&tail); err != io.EOF {
						t.Fatalf("stream did not end: %v", err)
					}
					var id string
					_ = json.Unmarshal(result["call_id"], &id)
					if id != first["call_id"] {
						t.Fatalf("call changed: %s", id)
					}
				} else {
					if err := decoder.Decode(&result); err != nil {
						t.Fatal(err)
					}
				}
				for _, field := range []string{"call_id", "trace", "attempts", "duration_ms"} {
					if result[field] == nil {
						t.Errorf("missing %s", field)
					}
				}
				var nodes []core.Node
				_ = json.Unmarshal(result["trace"], &nodes)
				if len(nodes) < 4 || nodes[0].Name != tool || nodes[0].Status != "ok" {
					t.Fatalf("trace=%s", result["trace"])
				}
				if tool == "fetch" {
					if overrides := nodes[0].Attrs["overrides"].(map[string]any); overrides["no_cache"] != false || len(overrides) != 1 {
						t.Fatalf("overrides=%v", overrides)
					}
				}
			})
		}
	}
}

func TestPlayArgumentErrorsStayJSON(t *testing.T) {
	for _, tool := range []string{"search", "dev_search", "fetch"} {
		t.Run(tool, func(t *testing.T) {
			a, base := liveServer(t)
			res := liveRequest(t, "POST", base+"/api/play/"+tool, `{}`, "application/x-ndjson")
			var body map[string]any
			_ = json.NewDecoder(res.Body).Decode(&body)
			if res.StatusCode != 400 || !strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") || body["error"] == nil || len(a.Live.Snapshot().Calls) != 0 {
				t.Fatalf("status=%d body=%v", res.StatusCode, body)
			}
		})
	}
}

type sseMessage struct {
	event string
	data  json.RawMessage
}

func readSSE(t *testing.T, scanner *bufio.Scanner) sseMessage {
	t.Helper()
	out := sseMessage{}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" && out.data != nil {
			return out
		}
		if strings.HasPrefix(line, "event: ") {
			out.event = strings.TrimPrefix(line, "event: ")
		}
		if strings.HasPrefix(line, "data: ") {
			out.data = json.RawMessage(strings.TrimPrefix(line, "data: "))
		}
	}
	t.Fatalf("SSE ended: %v", scanner.Err())
	return out
}

func TestLiveAndLogSSE(t *testing.T) {
	a, base := liveServer(t)
	logs := liveRequest(t, "GET", base+"/api/logs/stream", "", "")
	global := bufio.NewScanner(logs.Body)
	if e := readSSE(t, global); e.event != "snapshot" || !strings.Contains(string(e.data), `"calls":[]`) {
		t.Fatalf("global snapshot=%s %s", e.event, e.data)
	}
	trace := core.NewTrace()
	ctx, cancel := context.WithCancelCause(core.WithTrace(context.Background(), trace))
	defer cancel(nil)
	trace.Root("fetch", map[string]any{"source": "webui"})
	_, span := core.StartSpan(ctx, "llm", "fake", nil)
	span.Text("hello")
	a.Live.Start(app.LiveCall{CallID: trace.CallID, Tool: "fetch", Source: "webui", Summary: "fake", TaskID: "rs_fake", StartedAt: trace.Start.UnixMilli()}, trace, cancel)
	if e := readSSE(t, global); e.event != "call" || !strings.Contains(string(e.data), trace.CallID) {
		t.Fatalf("call=%s %s", e.event, e.data)
	}
	stream := liveRequest(t, "GET", base+"/api/live/"+trace.CallID+"/stream", "", "")
	scanner := bufio.NewScanner(stream.Body)
	if e := readSSE(t, scanner); e.event != "snapshot" || !strings.Contains(string(e.data), `"2":"hello"`) {
		t.Fatalf("snapshot=%s %s", e.event, e.data)
	}
	span.Set(map[string]any{"try": 2})
	if e := readSSE(t, scanner); e.event != "node" || !strings.Contains(string(e.data), `"try":2`) {
		t.Fatalf("node=%s %s", e.event, e.data)
	}
	span.Text(" world")
	if e := readSSE(t, scanner); e.event != "text" || string(e.data) != `{"node":2,"delta":" world"}` {
		t.Fatalf("text=%s %s", e.event, e.data)
	}
	live := liveRequest(t, "GET", base+"/api/live", "", "")
	var list app.LiveSnapshot
	_ = json.NewDecoder(live.Body).Decode(&list)
	if len(list.Calls) != 1 || list.Calls[0].CallID != trace.CallID {
		t.Fatalf("live=%+v", list)
	}
	canceled := liveRequest(t, "POST", base+"/api/live/"+trace.CallID+"/cancel", "", "")
	if canceled.StatusCode != 200 || context.Cause(ctx) != app.ErrCallStopped {
		t.Fatal("HTTP cancel failed")
	}
	trace.Seal("canceled", app.ErrCallStopped.Error())
	a.Live.Finish(trace.CallID, core.CallDone{CallID: trace.CallID, Status: "canceled", DurationMs: 10, Error: app.ErrCallStopped.Error()})
	for {
		if e := readSSE(t, scanner); e.event == "done" {
			if strings.Contains(string(e.data), "call_id") || !strings.Contains(string(e.data), `"status":"canceled"`) {
				t.Fatalf("done=%s", e.data)
			}
			break
		}
	}
	if scanner.Scan() {
		t.Fatalf("stream continued after done: %s", scanner.Text())
	}
	late := liveRequest(t, "GET", base+"/api/live/"+trace.CallID+"/stream", "", "")
	lateScanner := bufio.NewScanner(late.Body)
	if readSSE(t, lateScanner).event != "snapshot" || readSSE(t, lateScanner).event != "done" || lateScanner.Scan() {
		t.Fatal("late subscriber lost final snapshot/done")
	}
	if res := liveRequest(t, "POST", base+"/api/live/"+trace.CallID+"/cancel", "", ""); res.StatusCode != 409 {
		t.Fatalf("finished cancel=%d", res.StatusCode)
	}
	if res := liveRequest(t, "GET", base+"/api/live/c_unknown/stream", "", ""); res.StatusCode != 404 {
		t.Fatalf("unknown=%d", res.StatusCode)
	}
	tree, _ := json.Marshal(trace.Nodes())
	if err := a.Store.CreateTask(context.Background(), "rs_fake", "Question", nil); err != nil {
		t.Fatal(err)
	}
	a.Logs.Write(store.LogEntry{TS: trace.Start.UnixMilli(), Tool: "fetch", Source: "webui", Status: "error", CallID: trace.CallID, TaskID: "rs_fake", Trace: tree})
	doneSeen, logSeen := false, false
	for !doneSeen || !logSeen {
		e := readSSE(t, global)
		if e.event == "done" {
			doneSeen = true
		}
		if e.event == "" {
			logSeen = true
			var entry store.LogEntry
			_ = json.Unmarshal(e.data, &entry)
			if entry.CallID != trace.CallID || len(entry.Trace) != 0 {
				t.Fatalf("log event=%s", e.data)
			}
		}
	}
	full := liveRequest(t, "GET", base+"/api/logs/call/"+trace.CallID, "", "")
	var log store.LogEntry
	_ = json.NewDecoder(full.Body).Decode(&log)
	if full.StatusCode != 200 || log.CallID != trace.CallID || len(log.Trace) == 0 {
		t.Fatalf("log=%+v", log)
	}
	taskRes := liveRequest(t, "GET", base+"/api/research/tasks/rs_fake", "", "")
	var task struct {
		CallID string `json:"call_id"`
		LogID  int64  `json:"log_id"`
	}
	_ = json.NewDecoder(taskRes.Body).Decode(&task)
	if task.CallID != trace.CallID || task.LogID != log.ID {
		t.Fatalf("task=%+v", task)
	}
	if res := liveRequest(t, "GET", base+"/api/logs/call/c_unknown", "", ""); res.StatusCode != 404 {
		t.Fatal("missing log found")
	}
}

func TestLiveEndpointsRequireAuth(t *testing.T) {
	_, base := liveServer(t)
	for _, path := range []string{"/api/live", "/api/live/c_x/stream", "/api/logs/call/c_x", "/api/logs/stream"} {
		res, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 401 {
			t.Fatalf("%s=%d", path, res.StatusCode)
		}
	}
	req, _ := http.NewRequest("POST", base+"/api/live/c_x/cancel", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal("cancel lacks auth")
	}
}

func TestPlayExtractStreamsRawText(t *testing.T) {
	a, base := liveServer(t)
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	defer release()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			_, _ = w.Write([]byte(`{"data":{"content":"a long fake page"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"fake\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"raw model words\"},\"finish_reason\":null}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-gate:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"id\":\"fake\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	cfg := a.Snapshot().Config.Clone()
	cfg.Fetch.Routes = []config.Route{{Provider: "jina", Enabled: true}}
	cfg.Providers["jina"].BaseURL = upstream.URL
	cfg.Fetch.PassthroughLength = 1
	cfg.LLM.Providers = []config.LLMProvider{{ID: "p", Name: "P", Type: config.LLMOpenAICompatible, BaseURL: upstream.URL + "/v1", Secret: config.Secret{APIKey: "fake"}, Models: []config.Model{{ID: "m", Name: "fake"}}}}
	cfg.Fetch.Extract.Models = []string{"m"}
	if err := a.SaveConfig(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	res := liveRequest(t, "POST", base+"/api/play/fetch", `{"url":"https://example.test/page","prompt":"question"}`, "application/x-ndjson")
	decoder := json.NewDecoder(res.Body)
	var first map[string]string
	if err := decoder.Decode(&first); err != nil || first["call_id"] == "" {
		t.Fatalf("first=%v err=%v", first, err)
	}
	var text strings.Builder
	for {
		var line struct {
			Text   *core.TextDelta `json:"text"`
			Result json.RawMessage `json:"result"`
		}
		if err := decoder.Decode(&line); err != nil {
			t.Fatal(err)
		}
		if len(line.Result) > 0 {
			if text.String() != "raw model words" {
				t.Fatalf("text=%q", text.String())
			}
			break
		}
		if line.Text != nil {
			text.WriteString(line.Text.Delta)
			// Releasing the final frame here proves text is delivered during the call.
			release()
		}
	}
}
