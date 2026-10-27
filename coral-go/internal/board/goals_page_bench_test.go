package board

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
)

// #9580 (Goal #102): GET /api/board/{b}/goals stage by stage on a seeded board (never the live database): 120 goals (40 open, 80 closed) and 5,000 tasks, nine in ten linked to a goal (mostly the closed ones):
//
//	go test ./internal/board -run xxx -bench GoalPage -benchtime 100x -benchmem
func BenchmarkGoalPage(b *testing.B) {
	s, err := NewStoreWithKey(filepath.Join(b.TempDir(), "board_goals_bench.db"), "")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	ctx := context.Background()
	var ids []int64
	for i := 0; i < 120; i++ {
		g, err := s.CreateGoal(ctx, "team", GoalInput{Title: fmt.Sprintf("Goal %d", i), Outcome: "An outcome of a few lines of text. ", DoneWhen: "Done when it is done.", CreatedBy: "Orchestrator"})
		if err != nil {
			b.Fatal(err)
		}
		ids = append(ids, g.ID)
		if i >= 40 {
			if _, err := s.db.ExecContext(ctx, `UPDATE board_goals SET state = 'done' WHERE id = ?`, g.ID); err != nil {
				b.Fatal(err)
			}
		}
	}
	seedTaskBoard(b, s, 1500, 3500)
	for i := 1; i <= 5000; i++ {
		if i%10 == 0 {
			continue // no goal
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET goal_id = ? WHERE id = ?`, ids[i%len(ids)], i); err != nil {
			b.Fatal(err)
		}
	}
	b.Run("whole_page", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if p, err := s.GoalPage(ctx, "team", GoalListQuery{}); err != nil || len(p.Goals) != 40 {
				b.Fatal(err)
			}
		}
	})
	page, _ := s.GoalPage(ctx, "team", GoalListQuery{})
	var pageIDs []int64
	for _, g := range page.Goals {
		pageIDs = append(pageIDs, g.ID)
	}
	b.Run("goal_rows", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			var goals []Goal
			if err := s.reader().SelectContext(ctx, &goals, `SELECT `+goalColumns+` FROM board_goals WHERE board_id = ? AND state IN ('proposed','active','blocked') ORDER BY id ASC LIMIT 51`, "team"); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("rollups", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, err := s.goalRollups(ctx, "team", pageIDs); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("rollups_by_goals", func(b *testing.B) {
		b.ReportAllocs()
		goals := page.Goals
		for i := 0; i < b.N; i++ {
			if _, err := s.goalRollupsByID(ctx, goals); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("no_goal_count", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, err := s.noGoalOpenTasks(ctx, "team"); err != nil {
				b.Fatal(err)
			}
		}
	})
}
