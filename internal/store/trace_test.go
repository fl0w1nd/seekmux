package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestTraceUpgrade(t *testing.T) {
	for _, old := range []bool{true, false} {
		name := "new"
		if old {
			name = "old"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if old {
				db, err := sql.Open("sqlite", filepath.Join(dir, "seekmux.db"))
				if err != nil {
					t.Fatal(err)
				}
				_, err = db.Exec(`CREATE TABLE request_logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,tool TEXT NOT NULL,source TEXT NOT NULL,
     api_key_id INTEGER NOT NULL DEFAULT 0,api_key_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,provider TEXT NOT NULL DEFAULT '',summary TEXT NOT NULL DEFAULT '',
     request TEXT NOT NULL DEFAULT '',response TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',
     attempts TEXT NOT NULL DEFAULT '[]',input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0);
     INSERT INTO request_logs(ts,tool,source,status,duration_ms,summary) VALUES(1,'fetch','mcp','ok',3,'old');`)
				db.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			st, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			ctx := context.Background()
			if old {
				e, found, err := st.GetLog(ctx, 1)
				if err != nil || !found || e.CallID != "" || len(e.Trace) != 0 || e.Summary != "old" {
					t.Fatalf("old=%+v found=%v err=%v", e, found, err)
				}
			}
			tree := json.RawMessage(`[{"id":1,"kind":"call","name":"fetch","status":"ok","start_ms":0}]`)
			entries := st.insertLogs([]LogEntry{{TS: 2, Tool: "fetch", Source: "webui", Status: "ok", CallID: "c_fake", TaskID: "rs_fake", Trace: tree, Attempts: json.RawMessage(`[]`)}})
			if len(entries) != 1 {
				t.Fatal("insert failed")
			}
			got, found, err := st.GetLogByCall(ctx, "c_fake")
			if err != nil || !found || got.CallID != "c_fake" || string(got.Trace) != string(tree) {
				t.Fatalf("get=%+v err=%v", got, err)
			}
			if byTask, found, err := st.LogIDByTask(ctx, "rs_fake"); err != nil || !found || byTask != got.ID {
				t.Fatalf("task=%+v err=%v", byTask, err)
			}
			if _, found, err := st.LogIDByTask(ctx, "rs_missing"); err != nil || found {
				t.Fatalf("missing task: found=%v err=%v", found, err)
			}
			newer := st.insertLogs([]LogEntry{{TS: 3, Tool: "research", Source: "webui", Status: "ok", TaskID: "rs_fake", Attempts: json.RawMessage(`[]`)}})
			if id, found, err := st.LogIDByTask(ctx, "rs_fake"); err != nil || !found || id != newer[0].ID {
				t.Fatalf("latest task log=%d found=%v err=%v", id, found, err)
			}
			listed, err := st.ListLogs(ctx, LogFilter{Tool: "fetch"})
			if err != nil || listed[0].CallID != "c_fake" || len(listed[0].Trace) != 0 {
				t.Fatalf("list=%+v err=%v", listed, err)
			}
			if _, found, err := st.GetLogByCall(ctx, "c_missing"); err != nil || found {
				t.Fatal("missing call found")
			}
			var indexes int
			if err := st.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='index' AND name IN ('request_logs_call','request_logs_task') AND sql LIKE '%WHERE%'`).Scan(&indexes); err != nil || indexes != 2 {
				t.Fatalf("indexes=%d err=%v", indexes, err)
			}
		})
	}
}
