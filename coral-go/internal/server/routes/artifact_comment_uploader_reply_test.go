package routes

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #13762 (the Operator TOLD the agent that uploaded a file to read the comments on it, without Send to agent, and its replies were refused 'not asked'): an agent that uploaded the file replies in an open thread of its own
// file with no ask row, within Security's limits: only the verified uploader on that board, a reply in an existing open thread (never a new comment), the same cap per thread, 10 an hour on a file, authored as itself,
// and no ask row, no wake, nothing for any other agent. The Operator's Send to agent stays the only way an agent is asked in.

// reviewComment is the Operator's comment on a file IN REVIEW as the dashboard makes it: notify_agent false, so it is not sent to the agent that uploaded the file (#11420) and no ask row exists: the Operator's case.
func (rig *cmtRig) reviewComment(body string) int64 {
	rig.t.Helper()
	code, out := rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": body, "anchor": anchorOf("the lock"), "board": "team-a", "notify_agent": false})
	require.Equal(rig.t, http.StatusCreated, code, fmt.Sprint(out))
	return int64(out["id"].(float64))
}

func (rig *cmtRig) stored() []store.ArtifactComment {
	rig.t.Helper()
	list, err := rig.ss.ListArtifactComments(rig.t.Context(), cmtDoc, "", nil)
	require.NoError(rig.t, err)
	return list
}

func TestTheAgentThatUploadedTheFileRepliesInAThreadItWasNeverSentAndTheAskTableStaysEmpty(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBySession(sendSid(1), "team-a")
	cid := rig.reviewComment("Is the nested field 1-2x slower?")

	code, rep := rig.reply(cid, asAgentSession(1), "Yes, about 1.5x on the 5,000 row set.")
	require.Equal(t, http.StatusCreated, code, "the uploader answers the comment it was told to read: "+fmt.Sprint(rep))
	author := rep["author"].(map[string]any)
	assert.Equal(t, "agent", author["kind"], "marked as an agent's, never the Operator's")
	assert.Equal(t, sendSid(1), author["subject"])
	assert.Equal(t, float64(cid), rep["parent_id"], "a reply in the thread")
	_, list := rig.do("GET", cp(cmtDoc), cmtAsOwner, nil)
	assert.Len(t, list["comments"], 2, "the Operator sees it in the thread")
	asked, err := rig.ss.HasArtifactAsk(t.Context(), cmtDoc, sendSid(1))
	require.NoError(t, err)
	assert.False(t, asked, "no ask row was opened: the Operator's Send to agent is still the only way an agent is asked in")
}

func TestOnlyTheUploaderRepliesAndOnlyInAnOpenExistingThread(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "QA", false)
	rig.uploadedBySession(sendSid(1), "team-a")
	cid := rig.reviewComment("hello")

	code, out := rig.reply(cid, asAgentSession(2), "me too")
	assert.Equal(t, http.StatusForbidden, code, "an agent on the board that did not upload the file")
	assert.Equal(t, "not_asked", out["code"])
	assert.Contains(t, fmt.Sprint(out["error"])+fmt.Sprint(out["message"]), "Send to agent", "and the refusal says how to be let in")

	// not a new top-level comment: the agent route has no such thing; a reply into a REPLY is refused
	code, rep := rig.reply(cid, asAgentSession(1), "first")
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(rep))
	replyID := int64(rep["id"].(float64))
	code, _ = rig.reply(replyID, asAgentSession(1), "a reply to a reply")
	assert.Equal(t, http.StatusBadRequest, code, "only a reply in the thread's own first comment")

	// a resolved thread is closed to it
	other := rig.reviewComment("another")
	rc, _ := rig.do("POST", fmt.Sprintf("%s/%d/resolve", cp(cmtDoc), other), cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, rc)
	code, out = rig.reply(other, asAgentSession(1), "late")
	assert.Equal(t, http.StatusForbidden, code, fmt.Sprint(out))
	// the uploader on ANOTHER board's file is nobody here: its upload record is for another team's session
	agentWords := 0
	for _, c := range rig.stored() {
		if c.AuthorKind == "agent" {
			agentWords++
		}
	}
	assert.Equal(t, 1, agentWords, "only the uploader's one reply was stored: the other agent, the reply to a reply and the resolved thread stored nothing")
}

func TestTheUploadersRepliesAreCappedPerThreadAndPerFilePerHour(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBySession(sendSid(1), "team-a")
	cid := rig.reviewComment("a long discussion")
	for i := 0; i < store.MaxAskReplies; i++ {
		code, rep := rig.reply(cid, asAgentSession(1), fmt.Sprintf("reply %d", i))
		require.Equal(t, http.StatusCreated, code, fmt.Sprint(i, rep))
	}
	code, rep := rig.reply(cid, asAgentSession(1), "one too many")
	assert.Equal(t, http.StatusConflict, code, "the same per-thread cap as an asked agent's")
	assert.Equal(t, "reply_limit", rep["code"])

	// the file's hourly cap across threads: MaxAskReplies were used above; more threads, up to the hour's 10
	used := store.MaxAskReplies
	for used < store.UploaderRepliesPerHour {
		next := rig.reviewComment(fmt.Sprintf("thread %d", used))
		code, rep := rig.reply(next, asAgentSession(1), "ok")
		require.Equal(t, http.StatusCreated, code, fmt.Sprint(used, rep))
		used++
	}
	last := rig.reviewComment("one more thread")
	code, rep = rig.reply(last, asAgentSession(1), "over the hour's cap")
	assert.Equal(t, http.StatusTooManyRequests, code, fmt.Sprint(rep))
	assert.Equal(t, "reply_rate", rep["code"])
}

// The same, as the remote computer sees the Hub path (#13762): the owner's comment and read arrive as API-key callers; the agent calls its own computer.
func TestTheUploaderOnARemoteComputerRepliesToACommentTheOperatorNeverSent(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBySession(sendSid(1), "team-a")
	code, out := rig.do("POST", cp(cmtDoc), cmtAsKey, map[string]any{"body": "Is this 1-2x slower?", "anchor": anchorOf("the lock"), "board": "team-a"})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	cid := int64(out["id"].(float64))
	code, rep := rig.reply(cid, asAgentSession(1), "About 1.5x.")
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(rep))
	code, list := rig.do("GET", cp(cmtDoc), cmtAsKey, nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, list["comments"], 2, "the Operator reads the agent's reply through the Hub's key")
}
