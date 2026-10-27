package board

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// #9554 (Goal #102): GET /api/board/{b}/tasks?limit=200 stage by stage on a seeded board (never the live database): 1,500 open and 3,500 done tasks, every task with a workflow of the size the team's tasks have
// (a completion message, artifacts, a review round), a fifth of the open ones blocked by another:
//
//	go test ./internal/board -run xxx -bench TaskListLimit200 -benchtime 50x -benchmem
func seedTaskBoardWithWorkflows(b testing.TB, s *Store, open, done int) {
	b.Helper()
	seedTaskBoard(b, s, open, done)
	ctx := context.Background()
	for i := 1; i <= open+done; i++ {
		wf := map[string]any{
			"outcome": "passed", "original_author": "Backend Dev",
			"completion_message": strings.Repeat("Done: the change is on the branch, tests pass. ", 20),
			"artifacts":          []map[string]string{{"uri": fmt.Sprintf("coral://artifacts/%064d", i), "name": "patch"}, {"uri": fmt.Sprintf("coral://artifacts/%064d", i+100000), "name": "shot"}},
			"review_rounds":      []map[string]any{{"round": 1, "reviewers": []map[string]string{{"reviewer": "QA Engineer", "verdict": "approve"}}}},
			"completion_review":  map[string]any{"artifacts": []map[string]string{{"uri": fmt.Sprintf("coral://artifacts/%064d", i)}}},
			"review_areas":       []string{"frontend"},
		}
		raw, _ := json.Marshal(wf)
		if _, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO task_workflows(task_id, data) VALUES(?, ?)`, i, string(raw)); err != nil {
			b.Fatal(err)
		}
		if i%5 == 0 && i > 1 && i <= open {
			if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO task_dependency_rules(task_id, upstream_id, condition, required_artifacts) VALUES(?, ?, 'completed', '[]')`, i, i-1); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func BenchmarkTaskListLimit200(b *testing.B) {
	s, err := NewStoreWithKey(filepath.Join(b.TempDir(), "board_bench.db"), "")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	seedTaskBoardWithWorkflows(b, s, 1500, 3500)
	ctx := context.Background()
	page, err := s.ListTaskPage(ctx, "team", TaskListQuery{Limit: 200})
	if err != nil {
		b.Fatal(err)
	}
	raw, _ := json.Marshal(page)
	b.Logf("limit 200: %d rows, %d bytes of JSON (%d per row)", len(page.Tasks), len(raw), len(raw)/max(len(page.Tasks), 1))
	b.Run("whole_page", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, err := s.ListTaskPage(ctx, "team", TaskListQuery{Limit: 200}); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("open_query", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, _, err := s.defaultTaskPage(ctx, "team", "", 200); err != nil {
				b.Fatal(err)
			}
		}
	})
	rows, _, _ := s.defaultTaskPage(ctx, "team", "", 200)
	b.Run("verification", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			s.loadListVerification(ctx, rows)
		}
	})
	b.Run("reviewers", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			fillListReviewers(rows)
		}
	})
	b.Run("artifact_counts", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			s.fillListArtifactCounts(ctx, rows)
		}
	})
	b.Run("blocked_by", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			if err := s.loadListBlockedBy(ctx, rows); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("totals", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			if _, _, err := s.taskListTotals(ctx, "team"); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("json_encode", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, err := json.Marshal(page); err != nil {
				b.Fatal(err)
			}
		}
	})
}

// Where the row read's time goes: the plain columns alone, then the workflow's expressions one group at a time.
func BenchmarkTaskListLimit200Columns(b *testing.B) {
	s, err := NewStoreWithKey(filepath.Join(b.TempDir(), "board_bench4.db"), "")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	seedTaskBoardWithWorkflows(b, s, 1500, 3500)
	ctx := context.Background()
	idsSQL := `SELECT t.id FROM board_tasks t WHERE t.board_id = ? AND t.` + openTaskStatusSQL + ` ORDER BY ` + openRankSQL + `, t.id ASC LIMIT 200`
	for name, sel := range map[string]string{
		"plain_only":     `t.id, t.revision, t.board_id, t.title, COALESCE(SUBSTR(t.body, 1, 200), ''), t.status, t.priority, t.created_by, t.assigned_to, t.completed_by, t.created_at, t.claimed_at, t.completed_at, t.session_id, t.goal_id, t.cost_usd`,
		"plus_body_only": `t.id, COALESCE(SUBSTR(t.body, 1, 200), '')`,
		"plus_outcome":   `t.id, COALESCE(json_extract(w.data, '$.outcome'), ''), COALESCE(json_type(w.data, '$.completion_review') = 'object', 0), json_extract(w.data, '$.original_author')`,
		"plus_reviewers": `t.id, COALESCE((SELECT json_group_array(json_extract(v.value, '$.reviewer')) FROM json_each(w.data, '$.review_rounds[#-1].reviewers') v), '[]')`,
		"plus_artifacts": `t.id, COALESCE(json_array_length(w.data, '$.artifacts'), 0) + COALESCE(json_array_length(w.data, '$.completion_review.artifacts'), 0), COALESCE(json_extract(w.data, '$.review_areas'), '[]'), COALESCE(json_extract(w.data, '$.reviewers_wanted'), 0)`,
	} {
		sel := sel
		b.Run(name, func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				rows, err := s.reader().QueryxContext(ctx, `SELECT `+sel+` FROM board_tasks t LEFT JOIN task_workflows w ON w.task_id = t.id WHERE t.id IN (`+idsSQL+`)`, "team")
				if err != nil {
					b.Fatal(err)
				}
				for rows.Next() {
					if _, err := rows.SliceScan(); err != nil {
						b.Fatal(err)
					}
				}
				rows.Close()
			}
		})
	}
}

// The reply's own costs after the store: the validator hash and the gzip of the page's JSON.
func BenchmarkTaskListLimit200Reply(b *testing.B) {
	s, err := NewStoreWithKey(filepath.Join(b.TempDir(), "board_bench5.db"), "")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	seedTaskBoardWithWorkflows(b, s, 1500, 3500)
	page, err := s.ListTaskPage(context.Background(), "team", TaskListQuery{Limit: 200})
	if err != nil {
		b.Fatal(err)
	}
	raw, _ := json.Marshal(page)
	b.Run("sha256", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			sha256.Sum256(raw)
		}
	})
	var zlen int
	b.Run("gzip", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			var buf bytes.Buffer
			zw := gzip.NewWriter(&buf)
			zw.Write(raw)
			zw.Close()
			zlen = buf.Len()
		}
	})
	b.Logf("json %d bytes, gzip %d bytes", len(raw), zlen)
}

// What the open-time check costs on 5,000 workflows (every open re-derives the rows that disagree; here none do).
func BenchmarkWorkflowListFactsOpen(b *testing.B) {
	s, err := NewStoreWithKey(filepath.Join(b.TempDir(), "board_bench6.db"), "")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	seedTaskBoardWithWorkflows(b, s, 1500, 3500)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := s.ensureWorkflowListFacts(ctx); err != nil {
			b.Fatal(err)
		}
	}
}

// #9567: the done page (status=completed, and the second half of the default list) stage by stage, 200 rows.
func BenchmarkTaskListDonePage200(b *testing.B) {
	s, err := NewStoreWithKey(filepath.Join(b.TempDir(), "board_bench7.db"), "")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	seedTaskBoardWithWorkflows(b, s, 1500, 3500)
	ctx := context.Background()
	b.Run("whole_page", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if p, err := s.ListTaskPage(ctx, "team", TaskListQuery{Status: TaskListCompleted, Limit: 200}); err != nil || len(p.Tasks) != 200 {
				b.Fatal(err)
			}
		}
	})
	rows, _, _ := s.doneTaskPage(ctx, "team", "", 200)
	b.Run("done_query", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, _, err := s.doneTaskPage(ctx, "team", "", 200); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("verification", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			s.loadListVerification(ctx, rows)
		}
	})
	b.Run("load_documents_only", func(b *testing.B) {
		b.ReportAllocs()
		ids := make([]int64, len(rows))
		for i := range rows {
			ids[i] = rows[i].ID
		}
		for i := 0; i < b.N; i++ {
			if _, err := s.loadWorkflowData(ctx, ids); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("other_stages", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			fillListReviewers(rows)
			s.fillListArtifactCounts(ctx, rows)
			_ = s.loadListBlockedBy(ctx, rows)
			_, _, _ = s.taskListTotals(ctx, "team")
		}
	})
}
