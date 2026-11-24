package routes

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #21195 (S3 of #21189): Approve or Request changes with drafts pending records the decision and sends the drafts as one message, together or not at all.

const draftsOwner = "local|install-owner-id"

func (c *changesEnv) holdDraft(t *testing.T, body string) {
	t.Helper()
	_, _, err := c.ss.CreateReviewDraft(context.Background(), store.ReviewDraft{ArtifactID: c.id, Owner: draftsOwner, Board: "alpha", AnchorJSON: `{"whole":true}`, Body: body})
	require.NoError(t, err)
}

func (c *changesEnv) draftRev(t *testing.T) int64 {
	t.Helper()
	_, rev, err := c.ss.ListReviewDrafts(context.Background(), c.id, draftsOwner)
	require.NoError(t, err)
	return rev
}

func (c *changesEnv) pending(t *testing.T) int {
	t.Helper()
	ds, _, err := c.ss.ListReviewDrafts(context.Background(), c.id, draftsOwner)
	require.NoError(t, err)
	return len(ds)
}

func (c *changesEnv) decide(t *testing.T, decision, extra, requestID string, rev int64) (int, map[string]any) {
	t.Helper()
	body := fmt.Sprintf(`{"decision":%q,%s"send_drafts":{"request_id":%q,"revision":%d}}`, decision, extra, requestID, rev)
	return c.changes(t, body)
}

func newDraftsEnv(t *testing.T) *changesEnv {
	c := newChangesEnv(t)
	c.h.SetReviewDrafts(c.sh)
	return c
}

func TestApproveWithDraftsIsOneMessageAndOneRecordedDecision(t *testing.T) {
	c := newDraftsEnv(t)
	c.holdDraft(t, "Fix the typo in section 2.")
	c.holdDraft(t, "Add the retry count.")
	code, out := c.decide(t, "approve", `"note":"Ship it after these.",`, "decide-0001", c.draftRev(t))
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "approved", out["state"])
	assert.Equal(t, true, out["changed"])
	assert.Equal(t, true, out["delivered"])
	assert.EqualValues(t, 2, out["drafts_sent"])
	msgs := c.messages(t)
	require.Len(t, msgs, 1, "the decision and the comments are ONE message: no separate approval notice")
	assert.Contains(t, msgs[0], "@Alice ")
	assert.Contains(t, msgs[0], "approved this file")
	assert.Contains(t, msgs[0], "Ship it after these.")
	assert.Contains(t, msgs[0], "Fix the typo in section 2.")
	assert.Contains(t, msgs[0], "Add the retry count.")
	assert.Equal(t, 0, c.pending(t))
	assert.Len(t, c.comments(t), 2)
	assert.Contains(t, c.state(t), "approved")
}

func TestRequestChangesWithWordsAndDraftsMakesTheWordsTheFirstComment(t *testing.T) {
	c := newDraftsEnv(t)
	c.holdDraft(t, "Also check the footer.")
	code, out := c.decide(t, "changes", `"text":"Use 5,000 rows per batch.",`, "decide-0002", c.draftRev(t))
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "changes requested", out["state"])
	cs := c.comments(t)
	require.Len(t, cs, 2)
	assert.Equal(t, "Changes requested: Use 5,000 rows per batch.", cs[0].Body, "the words are the first comment")
	assert.Equal(t, "Also check the footer.", cs[1].Body)
	msgs := c.messages(t)
	require.Len(t, msgs, 1, "one message, not one for the words and one for the drafts")
	assert.Contains(t, msgs[0], "asks for changes")
	assert.Less(t, strings.Index(msgs[0], "Use 5,000 rows"), strings.Index(msgs[0], "Also check the footer."))
}

func TestADecisionWhoseDraftsCannotBeSentIsNotRecorded(t *testing.T) {
	c := newDraftsEnv(t)
	c.holdDraft(t, "one")
	rev := c.draftRev(t)

	// stale revision: the drafts changed since the person looked
	c.holdDraft(t, "two")
	code, out := c.decide(t, "approve", "", "decide-0003", rev)
	assert.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, "stale_revision", out["code"])
	assert.NotContains(t, c.state(t), "approved", "nothing was decided")

	// too large for one message
	for i := 0; i < 5; i++ {
		c.holdDraft(t, strings.Repeat("x", 7000)+fmt.Sprint(i))
	}
	code, out = c.decide(t, "approve", "", "decide-0004", c.draftRev(t))
	assert.Equal(t, http.StatusRequestEntityTooLarge, code, out)
	assert.Equal(t, "review_too_large", out["code"])
	assert.NotContains(t, c.state(t), "approved")
	assert.Empty(t, c.messages(t))
	assert.Equal(t, 7, c.pending(t), "every draft is still a draft")
	assert.Empty(t, c.comments(t))
}

func TestADecisionWhoseMessageReachesNoAgentIsUndoneAndKeepsTheDrafts(t *testing.T) {
	c := newDraftsEnv(t)
	c.holdDraft(t, "one")
	require.NoError(t, c.ss.SetSessionArchived(context.Background(), sessAlice, true))
	code, out := c.decide(t, "approve", "", "decide-0005", c.draftRev(t))
	assert.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, "not_delivered", out["code"])
	assert.NotContains(t, c.state(t), "approved", "the approval was taken back")
	assert.Equal(t, 1, c.pending(t))
	assert.Empty(t, c.comments(t))
	// the button can be pressed again once the agent is back
	require.NoError(t, c.ss.SetSessionArchived(context.Background(), sessAlice, false))
	code, out = c.decide(t, "approve", "", "decide-0005", c.draftRev(t))
	require.Equal(t, http.StatusOK, code, out)
	assert.Contains(t, c.state(t), "approved")
}

func TestAFileDecidedBeforeKeepsItsDraftsAndSendsNothing(t *testing.T) {
	c := newDraftsEnv(t)
	code, out := c.changes(t, `{"decision":"approve"}`)
	require.Equal(t, http.StatusOK, code, out)
	before := len(c.messages(t))
	c.holdDraft(t, "late thought")
	code, out = c.decide(t, "approve", "", "decide-0006", c.draftRev(t))
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, false, out["changed"])
	assert.Len(t, c.messages(t), before, "nothing more was sent")
	assert.Equal(t, 1, c.pending(t), "the draft is still a draft")
}

func TestTheSamePressOfADecisionAnswersTheFirstAndDoesNothingMore(t *testing.T) {
	c := newDraftsEnv(t)
	c.holdDraft(t, "one")
	rev := c.draftRev(t)
	code, first := c.decide(t, "approve", "", "decide-0007", rev)
	require.Equal(t, http.StatusOK, code, first)
	code, again := c.decide(t, "approve", "", "decide-0007", rev)
	require.Equal(t, http.StatusOK, code, again)
	assert.Equal(t, true, again["replayed"])
	assert.Len(t, c.messages(t), 1)
	assert.Len(t, c.comments(t), 1)
	// one shape (Orchestrator on #21185): the replay is the first answer's {state, review, batch, ...}, the batch the first one's, with replayed beside them
	keys := func(m map[string]any) []string {
		var k []string
		for key := range m {
			if key != "replayed" {
				k = append(k, key)
			}
		}
		sort.Strings(k)
		return k
	}
	assert.Equal(t, keys(first), keys(again))
	assert.Equal(t, first["state"], again["state"])
	assert.Equal(t, first["review"], again["review"])
	assert.Equal(t, first["to"], again["to"])
	assert.Equal(t, first["drafts_sent"], again["drafts_sent"])
	fb, _ := first["batch"].(map[string]any)
	ab, _ := again["batch"].(map[string]any)
	require.NotNil(t, ab, again)
	assert.Equal(t, fb["request_id"], ab["request_id"])
	assert.Equal(t, fb["comment_ids"], ab["comment_ids"])
	assert.Equal(t, true, ab["replayed"])
}

func TestSendDraftsGoesOnlyWithApproveOrChanges(t *testing.T) {
	c := newDraftsEnv(t)
	c.holdDraft(t, "one")
	for _, d := range []string{"deny", "ignore", "save"} {
		code, out := c.decide(t, d, "", "decide-0008", c.draftRev(t))
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", d, out)
	}
	assert.Equal(t, 1, c.pending(t))
	assert.Empty(t, c.messages(t))
}
