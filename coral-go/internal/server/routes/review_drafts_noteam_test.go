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
	_, rev, err := sh.ss.ListReviewDrafts(ctx, id, key)
	require.NoError(t, err)
	p, rf, replay := sh.prepareReviewSend(req, key, caller, id, noTeamBoardID, "noteam-0001", rev, "", "")
	require.Nil(t, rf, "%v", rf)
	require.Nil(t, replay)
	answer, rf := p.dispatch(ctx)
	require.Nil(t, rf, "%v", rf)
	assert.Equal(t, "sent", answer["status"])
	sent := mock.sentTo(name)
	require.Len(t, sent, 2, "one typed line per comment")
	assert.Contains(t, sent[0], "Please add the Q4 table.")
	assert.Contains(t, sent[0], "coral://artifacts/"+id)
	assert.Contains(t, sent[1], "Numbers look off here.")
	assert.Contains(t, sent[1], "Google Doc", "a Google comment says it is somebody else's words")
	left, _, err := sh.ss.ListReviewDrafts(ctx, id, key)
	require.NoError(t, err)
	assert.Empty(t, left)

	// a gone uploader: nothing typed, the comments are taken back and stay drafts
	setLive(false)
	hold("One more thing.", store.ReviewDraft{Source: store.ReviewDraftLocal})
	_, rev, err = sh.ss.ListReviewDrafts(ctx, id, key)
	require.NoError(t, err)
	p, rf, _ = sh.prepareReviewSend(req, key, caller, id, noTeamBoardID, "noteam-0002", rev, "", "")
	require.Nil(t, rf)
	_, rf = p.dispatch(ctx)
	require.NotNil(t, rf)
	assert.Equal(t, "not_delivered", rf.body["code"])
	assert.Len(t, mock.sentTo(name), 2, "nothing more was typed")
	left, _, err = sh.ss.ListReviewDrafts(ctx, id, key)
	require.NoError(t, err)
	assert.Len(t, left, 1)
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
