package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #21202: the drafts on a file of an agent on no team are sent to the one session that uploaded it, each comment typed through the no-team gate (there is no board to post on or reply in).
func TestDraftsOnANoTeamFileAreTypedIntoTheAgentThatUploadedIt(t *testing.T) {
	bh, mock, name, id, setLive := noTeamNoticeRig(t)
	_, sh, _, _ := setupSessionsTestServer(t)
	sh.SetBoardHandler(bh)
	ctx := context.Background()
	const key = "local|owner"
	caller := commentCaller{Kind: commentCallerOwner, Issuer: "local", Subject: "owner", Name: "Owner"}
	hold := func(body string, d store.ReviewDraft) {
		d.ArtifactID, d.Owner, d.Board, d.Body = id, key, noTeamBoardID, body
		if d.AnchorJSON == "" {
			d.AnchorJSON = `{"whole":true}`
		}
		_, _, err := sh.ss.CreateReviewDraft(ctx, d)
		require.NoError(t, err)
	}
	hold("Please add the Q4 table.", store.ReviewDraft{Source: store.ReviewDraftLocal})
	hold("Numbers look off here.", store.ReviewDraft{Source: store.ReviewDraftGdoc, SourceName: "Ann", SourceRef: "doc|c1"})

	targets, _, why := sh.reviewTargets(ctx, id, noTeamBoardID, nil)
	require.Empty(t, why, "Send is offered for a no-team file with one uploader")
	require.Len(t, targets, 1)
	assert.Equal(t, noTeamSession, targets[0].t.sessionID, "the session of the upload record")

	req := httptest.NewRequest(http.MethodPost, draftsPath(id)+"/send", nil)
	send := func(requestID string) (map[string]any, *reviewRefusal) {
		_, rev, err := sh.ss.ListReviewDrafts(ctx, id, key)
		require.NoError(t, err)
		p, rf, replay := sh.prepareReviewSend(req, key, caller, id, noTeamBoardID, requestID, rev, "", "")
		require.Nil(t, rf, "%v", rf)
		require.Nil(t, replay)
		return p.dispatch(ctx)
	}
	pending := func() int {
		left, _, err := sh.ss.ListReviewDrafts(ctx, id, key)
		require.NoError(t, err)
		return len(left)
	}

	// a gone uploader: nothing typed, nothing sent, every draft stays, and no thread was opened to it
	setLive(false)
	_, rf := send("noteam-0001")
	require.NotNil(t, rf)
	assert.Equal(t, "not_delivered", rf.body["code"])
	assert.Empty(t, mock.sentTo(name))
	assert.Equal(t, 2, pending(), "a send that was not typed keeps every draft")
	asks, err := sh.ss.ListArtifactAsks(ctx, id)
	require.NoError(t, err)
	assert.Empty(t, asks, "a send taken back grants no read")

	// the uploader goes away after one typing: the send is still ONE short line, typed once
	setLive(true)
	calls := 0
	bh.liveSessionType = func(context.Context, string) (string, bool, error) { calls++; return "claude", calls == 1, nil }
	answer, rf := send("noteam-0002")
	require.Nil(t, rf, "%v", rf)
	assert.Equal(t, "sent", answer["status"])
	sent := mock.sentTo(name)
	require.Len(t, sent, 1, "ONE typed line for every comment")
	assert.Contains(t, sent[0], "sent you 2 comments")
	assert.Contains(t, sent[0], "coral-agent artifact comments coral://artifacts/"+id, "the read that shows them in full")
	assert.NotContains(t, sent[0], "Q4 table", "no comment's words are typed")
	assert.Equal(t, 0, pending())

	// the agent is asked into exactly the threads sent, closed at once (no reminder to answer: there is no board to reply on)
	asks, err = sh.ss.ListArtifactAsks(ctx, id)
	require.NoError(t, err)
	require.Len(t, asks, 2)
	for _, a := range asks {
		assert.Equal(t, noTeamSession, a.AgentSession)
		assert.Equal(t, noTeamBoardID, a.Board)
		assert.NotNil(t, a.ClosedAt, "closed: it grants the read, not a reply or a reminder")
	}
}

// A no-team file nobody uploaded, or one two agents uploaded, names no one: Send is not offered, with the reason.
func TestDraftsOnANoTeamFileWithNoOneUploaderAreNotSent(t *testing.T) {
	bh, _, _, id, _ := noTeamNoticeRig(t)
	_, sh, _, _ := setupSessionsTestServer(t)
	sh.SetBoardHandler(bh)
	_, _, why := sh.reviewTargets(context.Background(), "ab"+id64tail, noTeamBoardID, nil)
	assert.Equal(t, "no_uploader", why)
	writeUpload(t, bh.coralDir, "00000000-0000-4000-8000-00000000b0b0", "the report", "report.md", "2026-10-09T10:05:00Z") // the same bytes, a second session
	_, _, why = sh.reviewTargets(context.Background(), id, noTeamBoardID, nil)
	assert.Equal(t, "ambiguous_uploader", why)
	assert.Contains(t, reviewNoTargetWords(why), "more than one agent")
	_, _, why = sh.reviewTargets(context.Background(), "ab"+id64tail, "", nil)
	assert.Equal(t, "no_board", why, "a comment with no board at all still has no one to go to")
}

const id64tail = "cdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"

// #21273: the review bar's "To:" names the uploading agent: its display name, cleaned like other agent names; the constant stays when it has none.
func TestANoTeamTargetCarriesTheUploadersName(t *testing.T) {
	bh, _, _, id, _ := noTeamNoticeRig(t)
	_, sh, _, _ := setupSessionsTestServer(t)
	sh.SetBoardHandler(bh)
	ctx := context.Background()

	targets, _, why := sh.reviewTargets(ctx, id, noTeamBoardID, nil)
	require.Empty(t, why)
	require.Len(t, targets, 1)
	assert.Equal(t, noTeamReviewTitle, targets[0].title, "no name known: the constant")

	require.NoError(t, sh.ss.SetDisplayName(ctx, noTeamSession, "Report \u202eWriter\n"))
	targets, _, why = sh.reviewTargets(ctx, id, noTeamBoardID, nil)
	require.Empty(t, why)
	require.Len(t, targets, 1)
	assert.Equal(t, "Report Writer", targets[0].title, "the uploader's name, cleaned")
	assert.True(t, targets[0].noTeam)

	require.NoError(t, sh.ss.SetDisplayName(ctx, noTeamSession, " \u202e\n"))
	targets, _, _ = sh.reviewTargets(ctx, id, noTeamBoardID, nil)
	require.Len(t, targets, 1)
	assert.Equal(t, noTeamReviewTitle, targets[0].title, "a name that cleans to nothing: the constant")
}
