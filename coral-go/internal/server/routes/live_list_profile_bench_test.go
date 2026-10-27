package routes

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #9597 (Goal #102): the state-events read of the live list (GetSessionStateEvents, one call for every awake agent) on 30 agents with 3,000 events each, a stop and a prompt every 25 tool uses, the way a long-running
// agent's table looks (never the live database):
//
//	go test ./internal/server/routes -run xxx -bench LiveStateEvents -benchtime 200x -benchmem
func BenchmarkLiveStateEvents(b *testing.B) {
	root := b.TempDir()
	db, err := storetest.Open(b, filepath.Join(root, "sessions.db"))
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	ts := store.NewTaskStore(db)
	tx, err := db.Begin()
	if err != nil {
		b.Fatal(err)
	}
	stmt, err := tx.Prepare(`INSERT INTO agent_events(agent_name,session_id,event_type,tool_name,summary,detail_json,created_at) VALUES('fixture',?,?,?,'',?,?)`)
	if err != nil {
		b.Fatal(err)
	}
	var ids []string
	for session := 0; session < 30; session++ {
		id := fmt.Sprintf("00000000-0000-0000-0000-%012d", session)
		ids = append(ids, id)
		for e := 0; e < 3000; e++ {
			typ, tool := "tool_use", "Edit"
			switch {
			case e%25 == 24:
				typ, tool = "stop", ""
			case e%25 == 0:
				typ, tool = "prompt_submit", ""
			case e%40 == 7:
				typ, tool = "notification", ""
			}
			if _, err := stmt.Exec(id, typ, tool, fmt.Sprintf(`{"file_path":"file-%d.go","command":"go test ./..."}`, e%30), fmt.Sprintf("2026-10-%02dT%02d:%02d:%02dZ", 1+e/150, (e/6)%24, e%60, session%60)); err != nil {
				b.Fatal(err)
			}
		}
	}
	stmt.Close()
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	ctx := context.Background()
	b.Run("state_events_30_agents", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, err := ts.GetSessionStateEvents(ctx, ids); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("state_events_1_agent", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, err := ts.GetSessionStateEvents(ctx, ids[:1]); err != nil {
				b.Fatal(err)
			}
		}
	})
}
