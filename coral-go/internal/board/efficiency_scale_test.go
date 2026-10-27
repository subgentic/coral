package board

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9288: the efficiency tasks read takes a workflow's four facts from columns, not from a decoded document. At 5,000 completed tasks (each with a document of a few kilobytes) it returns what the decoding
// read did (derived here from the same documents with decodeWorkflow), the open-time backfill derives the same columns saveWorkflow keeps, and the read stays inside a budget.
func TestEfficiencyTasksAtScaleReadTheFactColumns(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })

	const n = 5000
	base := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	pad := make([]string, 40)
	for i := range pad {
		pad[i] = fmt.Sprintf("an instruction or amendment line, number %d, padding the document to a realistic size", i)
	}
	docs := map[int64]TaskWorkflow{}
	tx, err := s.db.BeginTxx(ctx, nil)
	require.NoError(t, err)
	for i := 0; i < n; i++ {
		claimed := base.Add(time.Duration(i) * time.Minute)
		done := claimed.Add(7 * time.Minute)
		res, err := tx.ExecContext(ctx, `INSERT INTO board_tasks(board_id, title, status, created_by, assigned_to, created_at, claimed_at, completed_at, claim_thinking) VALUES ('team', ?, 'completed', 'Lead', 'Worker', ?, ?, ?, 'high')`,
			fmt.Sprintf("Task %d", i), claimed.Format(time.RFC3339), claimed.Format(time.RFC3339), done.Format(time.RFC3339))
		require.NoError(t, err)
		id, err := res.LastInsertId()
		require.NoError(t, err)
		w := TaskWorkflow{Instructions: fmt.Sprint(pad)}
		switch i % 5 {
		case 1:
			w.ReviewOf = int64(i)
		case 2:
			w.OriginalAuthor = "Author"
			w.CompletionReview = &CompletionReview{SubmittedAt: claimed.Add(3 * time.Minute).Format(time.RFC3339)}
		case 3:
			w.ReviewRounds = []ReviewRound{{Result: "rejected"}, {Result: "approved"}}
		}
		require.NoError(t, saveWorkflow(ctx, tx, id, w))
		docs[id] = w
	}
	require.NoError(t, tx.Commit())
	// one document that is not JSON, one empty: the read leaves their facts out
	var bad, empty int64
	require.NoError(t, s.db.GetContext(ctx, &bad, `SELECT MIN(id) FROM board_tasks`))
	empty = bad + 5
	_, err = s.db.ExecContext(ctx, `UPDATE task_workflows SET data = 'not json', eff_state = 2, eff_review_of = 0, eff_author = '', eff_submitted = '', eff_rejected = 0 WHERE task_id = ?`, bad)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE task_workflows SET data = '', eff_state = 3, eff_review_of = 0, eff_author = '', eff_submitted = '', eff_rejected = 0 WHERE task_id = ?`, empty)
	require.NoError(t, err)

	// what the decoding read made of each document
	type fact struct {
		review    bool
		claimer   string
		ended     string
		sentBack  bool
		withFacts bool
	}
	want := map[int64]fact{}
	rows, err := s.db.QueryxContext(ctx, `SELECT task_id, data FROM task_workflows`)
	require.NoError(t, err)
	for rows.Next() {
		var id int64
		var data string
		require.NoError(t, rows.Scan(&id, &data))
		f := fact{claimer: "Worker"}
		if data != "" {
			if w, err := decodeWorkflow(data, true); err == nil {
				f.withFacts = true
				f.review = w.ReviewOf > 0
				if w.OriginalAuthor != "" {
					f.claimer = w.OriginalAuthor
				}
				if w.CompletionReview != nil && w.CompletionReview.SubmittedAt != "" {
					f.ended = w.CompletionReview.SubmittedAt
				}
				for _, r := range w.ReviewRounds {
					if r.Result == "rejected" {
						f.sentBack = true
					}
				}
			}
		}
		want[id] = f
	}
	require.NoError(t, rows.Close())
	require.Len(t, want, n)

	check := func(label string) {
		start := time.Now()
		got, err := s.EfficiencyTasks(ctx, "2026-10-19T00:00:00Z", "2026-10-30T00:00:00Z")
		took := time.Since(start)
		require.NoError(t, err, label)
		seen := 0
		for _, g := range got {
			f := want[g.ID]
			assert.False(t, f.review, "%s: a review task is not listed (#%d)", label, g.ID)
			assert.Equal(t, f.claimer, g.Claimer, "%s: claimer of #%d", label, g.ID)
			assert.Equal(t, f.sentBack, g.SentBack, "%s: sent back, #%d", label, g.ID)
			if f.ended != "" {
				assert.Equal(t, f.ended, g.EndedAt, "%s: end of #%d", label, g.ID)
			}
			seen++
		}
		reviews := 0
		for _, f := range want {
			if f.review {
				reviews++
			}
		}
		assert.Equal(t, n-reviews, seen, "%s: every task but the review tasks", label)
		assert.Less(t, took, 2*time.Second, "%s: a generous budget (the read was about 0.17 s on the decoding path at this size on a quiet machine)", label)
	}
	check("as saved")

	// the backfill derives what saveWorkflow keeps: wipe the columns of the valid rows, run it, read again
	type cols struct {
		State     int    `db:"eff_state" json:"state"`
		ReviewOf  int64  `db:"eff_review_of" json:"review_of"`
		Author    string `db:"eff_author" json:"author"`
		Submitted string `db:"eff_submitted" json:"submitted"`
		Rejected  int    `db:"eff_rejected" json:"rejected"`
	}
	read := func() map[int64]cols {
		out := map[int64]cols{}
		rs, err := s.db.QueryxContext(ctx, `SELECT task_id, eff_state, eff_review_of, eff_author, eff_submitted, eff_rejected FROM task_workflows`)
		require.NoError(t, err)
		defer rs.Close()
		for rs.Next() {
			var id int64
			var c cols
			require.NoError(t, rs.Scan(&id, &c.State, &c.ReviewOf, &c.Author, &c.Submitted, &c.Rejected))
			out[id] = c
		}
		return out
	}
	before := read()
	_, err = s.db.ExecContext(ctx, `UPDATE task_workflows SET eff_state = 0, eff_review_of = 0, eff_author = '', eff_submitted = '', eff_rejected = 0`)
	require.NoError(t, err)
	require.NoError(t, s.ensureWorkflowEfficiencyFacts(ctx))
	after := read()
	b1, _ := json.Marshal(before)
	b2, _ := json.Marshal(after)
	assert.JSONEq(t, string(b1), string(b2), "the backfill derives the columns saveWorkflow keeps (including state 2 for a document that is not JSON, 3 for an empty one)")
	assert.Equal(t, 2, after[bad].State)
	assert.Equal(t, 3, after[empty].State)
	check("after the backfill")
}
