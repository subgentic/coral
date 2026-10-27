package board

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// #9113 (Goal #85): the default task list on a seeded board of 1,500 open and 3,500 done tasks (never the live database):
//
//	go test ./internal/board -run xxx -bench TaskListScale -benchtime 20x -benchmem
func seedTaskBoard(b testing.TB, s *Store, open, done int) {
	b.Helper()
	ctx := context.Background()
	for i := 0; i < open+done; i++ {
		t, err := s.CreateTask(ctx, "team", fmt.Sprintf("Task %d", i), strings.Repeat("body text ", 40), "medium", "Orchestrator")
		if err != nil {
			b.Fatal(err)
		}
		if i >= open {
			if _, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET status='completed', completed_by='Dev', completed_at=? WHERE id=?`, fmt.Sprintf("2026-10-%02dT08:%02d:00Z", 1+i%25, i%60), t.ID); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func BenchmarkTaskListScale(b *testing.B) {
	s, err := NewStoreWithKey(filepath.Join(b.TempDir(), "board_bench.db"), "")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	seedTaskBoard(b, s, 1500, 3500)
	ctx := context.Background()
	b.Run("default_list", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if p, err := s.ListTaskPage(ctx, "team", TaskListQuery{}); err != nil || len(p.Tasks) != 50 || p.NextCursor == "" || p.TotalOpen != 1500 { // the open set is paged (#9121): one page, not 1,500 rows
				b.Fatal(err)
			}
		}
	})
	b.Run("completed_page_50", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if p, err := s.ListTaskPage(ctx, "team", TaskListQuery{Status: TaskListCompleted, Limit: 50}); err != nil || len(p.Tasks) != 50 {
				b.Fatal(err)
			}
		}
	})
	b.Run("totals_grouped", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if o, d, err := s.taskListTotals(ctx, "team"); err != nil || o != 1500 || d != 3500 {
				b.Fatal(o, d, err)
			}
		}
	})
	b.Run("totals_only", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			var o, d int
			if err := s.reader().QueryRowxContext(ctx, `SELECT
		 COALESCE(SUM(CASE WHEN `+openTaskStatusSQL+` THEN 1 ELSE 0 END), 0),
		 COALESCE(SUM(CASE WHEN `+doneTaskStatusSQL+` THEN 1 ELSE 0 END), 0)
		 FROM board_tasks WHERE board_id = ?`, "team").Scan(&o, &d); err != nil || o != 1500 || d != 3500 {
				b.Fatal(o, d, err)
			}
		}
	})
}
