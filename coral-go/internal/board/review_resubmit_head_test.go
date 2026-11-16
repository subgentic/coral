package board

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A resubmit that names the commit a reviewer rejected is refused (#18135): #17069 went to round 4 at the commit round 3 had rejected, and
// a reviewer spent a round finding out nothing had changed.
func TestAResubmitAtTheRejectedCommitIsRefused(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevA": {}})
	task, err := e.s.CreateTask(e.ctx, "team", "Head check", "", "medium", "Lead", "Dev")
	require.NoError(t, err)
	_, err = e.s.ClaimTask(e.ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	arts := []TaskArtifact{{Name: "out", Content: "x", Revision: "r1"}}
	submit := func(head string) error {
		_, err := e.s.SubmitCompletionReviewAtHead(e.ctx, "team", task.ID, "Dev", "c", "success", "ready", arts, nil, "", head)
		return err
	}
	require.NoError(t, submit("3922878e7c1f"))
	_, _, err = e.s.HandToOrchestrator(e.ctx, "team", task.ID, "Dev")
	require.NoError(t, err)
	_, _, err = e.s.DelegateReview(e.ctx, "team", task.ID, "Lead", []string{"RevA"})
	require.NoError(t, err)
	_, err = e.s.RejectReview(e.ctx, "team", task.ID, "RevA", "fix it", 1)
	require.NoError(t, err)

	err = submit("3922878e7c")
	require.Error(t, err, "the same commit, short form")
	assert.Contains(t, err.Error(), "this is the commit that was rejected")
	assert.Contains(t, err.Error(), "push the fix first")
	err = submit("")
	require.Error(t, err, "no head named")
	assert.Contains(t, err.Error(), "name the commit you are submitting")
	require.NoError(t, submit("aaaaaaaaaaaa"), "a new commit goes through")
}

// A task whose first submit named no head is never checked: nothing older than this rule is refused.
func TestAResubmitIsNotCheckedWhenNoHeadWasRecorded(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevA": {}})
	id, _ := e.submit("Dev", "No head", nil, 1)
	e.claim("RevA")
	_, err := e.s.RejectReview(e.ctx, "team", id, "RevA", "fix it", 1)
	require.NoError(t, err)
	_, err = e.s.SubmitCompletionReviewAtHead(e.ctx, "team", id, "Dev", "c", "success", "again", []TaskArtifact{{Name: "out", Content: "y", Revision: "r2"}}, nil, "", "")
	require.NoError(t, err)
}

// A head that is not a commit id (7 to 64 hex characters) is refused at the first submit (#18457): a stored word would make a later unchanged resubmit pass or fail for the wrong reason.
func TestASubmitHeadMustBeACommitId(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevA": {}})
	task, err := e.s.CreateTask(e.ctx, "team", "Head shape", "", "medium", "Lead", "Dev")
	require.NoError(t, err)
	_, err = e.s.ClaimTask(e.ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	arts := []TaskArtifact{{Name: "out", Content: "x", Revision: "r1"}}
	submit := func(head string) error {
		_, err := e.s.SubmitCompletionReviewAtHead(e.ctx, "team", task.ID, "Dev", "c", "success", "ready", arts, nil, "", head)
		return err
	}
	for _, bad := range []string{"main", "abc123", "3922878e7c1g", "HEAD~1", "3922878e 7c1f", strings.Repeat("a", 65)} {
		err := submit(bad)
		require.Error(t, err, bad)
		assert.Contains(t, err.Error(), "7 to 64 hex characters", bad)
	}
	require.NoError(t, submit(strings.Repeat("A", 64)), "a full 64-hex id, upper case")
}
