package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17643: submit-review takes the commit at the head of the author's branch; free text is refused before anything is recorded; the review notice names it.
func TestSubmitReviewRecordsAndNamesTheSubmittedHead(t *testing.T) {
	base, h, task, _ := poolTeam(t, "head")
	code, out := submitWith(t, base, task.ID, map[string]any{"head_sha": "the trial merge"})
	require.Equal(t, http.StatusBadRequest, code, "%v", out)
	got, err := h.bs.GetTask(context.Background(), "head", task.ID)
	require.NoError(t, err)
	assert.Equal(t, "in_progress", got.Status, "a refused head records nothing")

	head := "0123456789abcdef0123456789abcdef01234567"
	code, out = submitWith(t, base, task.ID, map[string]any{"head_sha": head})
	require.Equal(t, http.StatusOK, code, "%v", out)
	got, err = h.bs.GetTask(context.Background(), "head", task.ID)
	require.NoError(t, err)
	require.NotNil(t, got.Workflow.CompletionReview)
	assert.Equal(t, head, got.Workflow.CompletionReview.HeadSHA)
	assert.Contains(t, boardText(t, h, "head"), "head "+head[:12], "the notice names the commit")
}
