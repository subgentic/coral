package board

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9594: the team artifacts list reads the artifact references from task_workflows.lst_art_refs, not from the whole document. The old read (select the document, decode it all) is spelled out and run on the same
// database against the new.
func oldTeamArtifactTasks(t *testing.T, s *Store, board string) []TeamArtifactTask {
	t.Helper()
	var rows []struct {
		ID   int64  `db:"id"`
		Data string `db:"data"`
	}
	require.NoError(t, s.reader().SelectContext(context.Background(), &rows, `SELECT t.id, w.data
		FROM task_workflows w INDEXED BY idx_task_workflows_artifacts CROSS JOIN board_tasks t ON t.id = w.task_id
		WHERE t.board_id = ? AND w.has_artifacts = 1 ORDER BY w.task_id DESC LIMIT 501`, board))
	var out []TeamArtifactTask
	for _, row := range rows {
		var w TaskWorkflow
		if json.Unmarshal([]byte(row.Data), &w) != nil {
			continue
		}
		if len(w.Artifacts) == 0 && (w.CompletionReview == nil || len(w.CompletionReview.Artifacts) == 0) {
			continue
		}
		var review *CompletionReview
		if w.CompletionReview != nil {
			review = &CompletionReview{SubmittedBy: w.CompletionReview.SubmittedBy, SubmittedAt: w.CompletionReview.SubmittedAt, Artifacts: w.CompletionReview.Artifacts}
		}
		out = append(out, TeamArtifactTask{TaskID: row.ID, Artifacts: w.Artifacts, Review: review})
	}
	return out
}

func randomArtifacts(rng *rand.Rand, tag string) []TaskArtifact {
	var out []TaskArtifact
	for i := rng.Intn(4); i > 0; i-- {
		switch rng.Intn(3) {
		case 0:
			out = append(out, TaskArtifact{Name: fmt.Sprintf("%s-%d.md", tag, i), URI: fmt.Sprintf("coral://artifacts/%064x", rng.Int63()), Digest: fmt.Sprintf("sha256:%064x", rng.Int63()), MediaType: "text/markdown", Kind: "report"})
		case 1:
			out = append(out, TaskArtifact{Name: fmt.Sprintf("%s-%d.txt", tag, i), Content: "inline \"quoted\" text\nwith a newline and ünïcode", MediaType: "text/plain"})
		default:
			out = append(out, TaskArtifact{Name: fmt.Sprintf("%s-%d", tag, i), URI: "https://example.invalid/x?a=1&b=2"})
		}
	}
	return out
}

func TestTeamArtifactTasksFromTheColumnMatchTheDocumentRead(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	rng := rand.New(rand.NewSource(9594))
	withBoth, withReviewOnly, withNone := 0, 0, 0
	for i := 0; i < 120; i++ {
		c, err := s.CreateTaskWithOpts(ctx, "alpha", fmt.Sprintf("task %d", i), "", "medium", "Orch", nil, "Dev")
		require.NoError(t, err)
		w := TaskWorkflow{Instructions: DefaultTaskWorkflowInstructions, Artifacts: randomArtifacts(rng, "done")}
		if rng.Intn(2) == 0 {
			w.CompletionReview = &CompletionReview{SubmittedBy: fmt.Sprintf("Dev %d", rng.Intn(3)), SubmittedAt: fmt.Sprintf("2026-10-%02dT10:00:00Z", 1+rng.Intn(27)), Artifacts: randomArtifacts(rng, "review")}
		}
		switch {
		case len(w.Artifacts) > 0 && w.CompletionReview != nil && len(w.CompletionReview.Artifacts) > 0:
			withBoth++
		case len(w.Artifacts) == 0 && w.CompletionReview != nil && len(w.CompletionReview.Artifacts) > 0:
			withReviewOnly++
		case len(w.Artifacts) == 0:
			withNone++
		}
		require.NoError(t, saveWorkflow(ctx, s.db, c.ID, w))
	}
	// a document that is not JSON, and one a task has no artifacts in
	bad, err := s.CreateTaskWithOpts(ctx, "alpha", "broken", "", "medium", "Orch", nil, "Dev")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `INSERT OR REPLACE INTO task_workflows(task_id, data, has_artifacts) VALUES (?, '{"artifacts":[ not json', 1)`, bad.ID)
	require.NoError(t, err)

	want := oldTeamArtifactTasks(t, s, "alpha")
	got, truncated, err := s.ListTeamArtifactTasksQuery(ctx, TeamArtifactQuery{Project: "alpha", Limit: MaxTeamArtifactTaskScan})
	require.NoError(t, err)
	assert.False(t, truncated)
	require.Equal(t, len(want), len(got))
	for i := range want {
		assert.Equal(t, want[i].TaskID, got[i].TaskID)
		assert.Equal(t, want[i].Artifacts, got[i].Artifacts, "task %d", want[i].TaskID)
		assert.Equal(t, want[i].Review, got[i].Review, "task %d", want[i].TaskID)
	}
	assert.Greater(t, len(want), 60, "tasks were compared")
	assert.Greater(t, withBoth, 5)
	assert.Greater(t, withReviewOnly, 5)
	assert.Greater(t, withNone, 5)
}
