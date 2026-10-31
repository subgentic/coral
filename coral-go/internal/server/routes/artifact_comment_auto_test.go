package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11420: the Operator's comment on an artifact that waits for their review reaches the agent that uploaded it, once, and the agent answers in the thread.

// uploadedBy records that agent n uploaded cmtDoc on board (the per-session upload record the artifact lists read).
func (rig *cmtRig) uploadedBy(n int, boardID string) { rig.uploadedBySession(sendSid(n), boardID) }

func (rig *cmtRig) uploadedBySession(sid, boardID string) {
	rig.t.Helper()
	dir := uploadsDir(rig.h.cfg.CoralDir(), sid)
	require.NotEmpty(rig.t, dir)
	require.NoError(rig.t, os.MkdirAll(dir, 0o755))
	rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "plan.md", MediaType: "text/markdown", Size: 4, Digest: cmtDoc}, CreatedAt: "2026-10-31T00:00:00Z", Board: boardID})
	require.NoError(rig.t, os.WriteFile(filepath.Join(dir, cmtDoc+".json"), rec, 0o644))
}

func (rig *cmtRig) tag(tags ...string) {
	rig.t.Helper()
	require.NoError(rig.t, rig.h.bs.SetArtifactTags(context.Background(), "team-a", cmtDoc, tags))
}

func (rig *cmtRig) commentAs(h map[string]string, extra map[string]any) (int, map[string]any) {
	body := map[string]any{"body": "Please use 5,000 rows per batch.", "anchor": anchorOf("the lock"), "board": "team-a"}
	for k, v := range extra {
		body[k] = v
	}
	return rig.do("POST", cp(cmtDoc), h, body)
}

func TestTheOperatorsCommentOnAForReviewUploadReachesTheUploaderOnce(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "QA", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")

	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Dev", out["sent_to"], "the answer says who it went to")
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "one message, to the uploader only")
	m := msgs[0].Content
	assert.Contains(t, m, "@Dev ")
	assert.Contains(t, m, "Please use 5,000 rows per batch.")
	assert.Contains(t, m, "From the Operator")
	assert.Contains(t, m, "untrusted")
	cid := int64(out["id"].(float64))
	assert.Contains(t, m, fmt.Sprintf("coral-agent artifact reply coral://artifacts/%s %d", cmtDoc, cid), "the reply command, filled in")
	ask, found, err := rig.ss.GetArtifactAsk(context.Background(), cid, sendSid(1))
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, cmtDoc, ask.ArtifactID)
	_, found, _ = rig.ss.GetArtifactAsk(context.Background(), cid, sendSid(2))
	assert.False(t, found, "no ask for the other agent")

	// the uploader's answer lands in that thread, as itself
	code, rep := rig.reply(cid, asAgentSession(1), "Done: 5,000 is fine.")
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(rep))
	assert.Equal(t, float64(cid), rep["parent_id"])
	assert.Equal(t, "agent", rep["author"].(map[string]any)["kind"])
	// another agent cannot answer into it
	code, rep = rig.reply(cid, asAgentSession(2), "me too")
	assert.Equal(t, http.StatusForbidden, code, fmt.Sprint(rep))

	// the Operator's reply in the thread is one more message, with the thread's own id in the command and no second ask
	code, out = rig.commentAs(cmtAsOwner, map[string]any{"body": "Thanks. And the retries?", "parent_id": cid, "anchor": nil})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	msgs = rig.operatorMessages()
	require.Len(t, msgs, 2, "once per comment")
	assert.Contains(t, msgs[1].Content, "And the retries?")
	assert.Contains(t, msgs[1].Content, fmt.Sprintf("%s %d \"your reply\"", cmtDoc, cid), "the reply command names the thread's first comment")
}

func TestACommentThatIsNotOnAForReviewUploadOfAnAgentSendsNothing(t *testing.T) {
	cases := map[string]func(rig *cmtRig){
		"the artifact is not for review": func(rig *cmtRig) { rig.tag("final") },
		"no tag at all":                  func(rig *cmtRig) {},
		"no agent uploaded it": func(rig *cmtRig) {
			rig.tag("for review")
			require.NoError(rig.t, os.RemoveAll(uploadsDir(rig.h.cfg.CoralDir(), sendSid(1))))
		},
		"it was uploaded on another board": func(rig *cmtRig) {
			rig.tag("for review")
			rig.uploadedBy(1, "team-b")
		},
		"it is a person's own upload (a paste), not an agent's": func(rig *cmtRig) {
			rig.tag("for review")
			dir := uploadsDir(rig.h.cfg.CoralDir(), sendSid(1))
			rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Digest: cmtDoc}, UploadedBy: "owner", Source: sourcePaste, Board: "team-a"})
			require.NoError(rig.t, os.WriteFile(filepath.Join(dir, cmtDoc+".json"), rec, 0o644))
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			rig := newCmtRig(t)
			rig.agent(1, "Dev", false)
			rig.uploadedBy(1, "team-a")
			setup(rig)
			code, out := rig.commentAs(cmtAsOwner, nil)
			require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
			assert.Nil(t, out["sent_to"])
			assert.Empty(t, rig.operatorMessages(), "nothing was sent")
			_, found, _ := rig.ss.GetArtifactAsk(context.Background(), int64(out["id"].(float64)), sendSid(1))
			assert.False(t, found, "no ask")
		})
	}
}

func TestTheOperatorCanKeepACommentFromTheAgentAndOnlyTheOperatorsCommentGoes(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")

	code, out := rig.commentAs(cmtAsOwner, map[string]any{"notify_agent": false})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Empty(t, rig.operatorMessages(), "the Operator chose otherwise")

	// a Coral Hub viewer's comment (and the owner's through the tunnel) is nobody's instruction to the agent: sent to no one
	rig.hubOn()
	code, out = rig.commentAs(cmtAsHub, nil)
	assert.Contains(t, []int{http.StatusCreated, http.StatusForbidden}, code, fmt.Sprint(out))
	code, out = rig.commentAs(cmtAsOwnerThroughTunnel, nil)
	assert.Contains(t, []int{http.StatusCreated, http.StatusForbidden}, code, fmt.Sprint(out))
	assert.Empty(t, rig.operatorMessages(), "only the person at this computer reaches the agent on their own")
}

func TestAnAsleepUploaderIsToldWhenItWakesAndABoardThatIsPausedSendsNothing(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Sleeper", true)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Sleeper", out["sent_to"], "the message waits unread on the board for it to wake")
	assert.Len(t, rig.operatorMessages(), 1)
}

func TestAnAgentThatDidNotUploadAnArtifactCannotListItsThreads(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "QA", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))

	for _, n := range []int{1, 2} { // the identity of an agent here is its session as "agent-<id>": subscribed on the board, so the board filter lets it see what it may
		_, err := rig.h.bs.Subscribe(context.Background(), "team-a", fmt.Sprintf("alias-%d", n), fmt.Sprintf("Alias%d", n), "agent-"+sendSid(n), nil, "")
		require.NoError(t, err)
	}
	code, list := rig.do("GET", cp(cmtDoc), asAgentSession(1), nil)
	require.Equal(t, http.StatusOK, code, fmt.Sprint(list))
	assert.Len(t, list["comments"], 1, "the uploader reads the threads on its own upload")
	code, list = rig.do("GET", cp(cmtDoc), asAgentSession(2), nil)
	assert.Equal(t, http.StatusForbidden, code, "another agent on the same board does not")
	assert.NotContains(t, fmt.Sprint(list), "5,000 rows")
}

// The owner's comment made through Coral Hub is saved but is not sent to the agent on its own: Send to agent is local only (never through the Hub), and so is this, until the Hub's operator answers.
func TestTheOwnersCommentThroughCoralHubIsKeptAndNotSentToTheAgent(t *testing.T) {
	rig := newCmtRig(t)
	withLabel(t, cmtHubUser, nil)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	code, out := rig.commentAs(cmtAsHubOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Nil(t, out["sent_to"])
	assert.Empty(t, rig.operatorMessages(), "the Hub's owner comment is not sent to an agent")
	_, list := rig.do("GET", cp(cmtDoc), cmtAsOwner, nil)
	assert.Len(t, list["comments"], 1, "but it is kept")
}
