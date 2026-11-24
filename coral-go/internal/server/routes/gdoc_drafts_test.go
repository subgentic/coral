package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gdocsync"
	"github.com/subgentic/coral/internal/store"
)

// #21196 (S4 of #21189): on a team's file the comments that come back from a shared Doc are held as drafts for the reviewer to send from Coral; the import notifies no one.

func teamGdocRig(t *testing.T) *gdocRig {
	t.Helper()
	g := newGdocRig(t, true)
	g.board = "team-a"
	g.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n\nThe launch is on Friday.\n\nShip the build.\n")
	g.writeSeriesVersion(t, gdocSid, gdocV1, 1)
	status, _, raw := g.share(t, gdocV1)
	require.Equal(t, 200, status, raw)
	g.artifact(t, gdocV2, "plan.md", "text/markdown", "# Plan\n\nThe launch is on Monday.\n\nShip the build.\n")
	g.writeSeriesVersion(t, gdocSid, gdocV2, 2)
	return g
}

func (g *gdocRig) drafts(t *testing.T) []store.ReviewDraft {
	t.Helper()
	key := g.h.gdocOwnerKey(context.Background())
	require.NotEmpty(t, key)
	ds, _, err := g.ss.ListReviewDrafts(context.Background(), gdocV2, key)
	require.NoError(t, err)
	return ds
}

func TestAGoogleCommentOnATeamsFileIsHeldAsADraftAndNotifiesNoOne(t *testing.T) {
	g := teamGdocRig(t)
	g.pass(&gdocSyncState{})
	cm := gdocComment("c1", "Dana Reviewer", "Is Monday firm?", "The launch is on Monday.")
	g.drive.comments = map[string][]gdocsync.Comment{"doc1": {cm}}
	g.pass(&gdocSyncState{})
	g.pass(&gdocSyncState{})

	assert.Empty(t, g.threads(t), "no published comment: the import keeps nothing as a comment")
	ds := g.drafts(t)
	require.Len(t, ds, 1, "added once, however many passes")
	assert.Equal(t, store.ReviewDraftGdoc, ds[0].Source)
	assert.Equal(t, "Dana Reviewer", ds[0].SourceName)
	assert.Equal(t, "doc1|c1", ds[0].SourceRef)
	assert.Equal(t, "team-a", ds[0].Board)
	assert.Contains(t, ds[0].AnchorJSON, "The launch is on Monday.")
	assert.Contains(t, ds[0].Body, "Is Monday firm?")

	// A reply in the Doc to a comment that is still a draft is a draft too, tied to it by its source.
	cm.Replies = []gdocsync.Reply{{ID: "r1", Content: "Yes.", Author: gdocsync.Author{DisplayName: "Lee"}}}
	g.drive.comments["doc1"] = []gdocsync.Comment{cm}
	g.pass(&gdocSyncState{})
	g.pass(&gdocSyncState{})
	ds = g.drafts(t)
	require.Len(t, ds, 2)
	assert.Equal(t, "doc1|c1/r1", ds[1].SourceRef)
	assert.Nil(t, ds[1].ParentID, "no published thread to be in yet")
	assert.Empty(t, g.threads(t))

	// A comment deleted in Google takes its unsent drafts with it.
	g.drive.comments["doc1"] = nil
	g.pass(&gdocSyncState{})
	assert.Empty(t, g.drafts(t))
}

func TestAGoogleDraftIsTheOwnersAloneAndSecretsAreNotKept(t *testing.T) {
	g := teamGdocRig(t)
	g.pass(&gdocSyncState{})
	secret := "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
	g.drive.comments = map[string][]gdocsync.Comment{"doc1": {gdocComment("c1", "Dana", "use "+secret, "")}}
	g.pass(&gdocSyncState{})
	ds := g.drafts(t)
	require.Len(t, ds, 1)
	assert.NotContains(t, ds[0].Body, secret)
	other, _, err := g.ss.ListReviewDrafts(context.Background(), gdocV2, "local|someone-else")
	require.NoError(t, err)
	assert.Empty(t, other, "another reviewer's list does not hold the owner's drafts")
}

func TestAFileOfNoTeamKeepsItsGoogleCommentsAsBefore(t *testing.T) {
	g := syncRig(t) // the legacy rig: no board
	g.pass(&gdocSyncState{})
	g.drive.comments = map[string][]gdocsync.Comment{"doc1": {gdocComment("c1", "Dana", "Is Monday firm?", "")}}
	g.pass(&gdocSyncState{})
	assert.Len(t, g.threads(t), 1, "a file with no team has no board to send on: the comment is kept as it was")
}

// Sent from Coral, an imported comment becomes a comment of its Google author (never the owner's words), the message says so, and an agent's reply goes back to the Doc.
func TestSendingImportedDraftsMarksThemAsGoogleAndMapsThemForTheReplyBack(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	ctx := context.Background()
	key := "local|install-owner-id"
	root, _, err := rig.ss.CreateReviewDraft(ctx, store.ReviewDraft{ArtifactID: cmtDoc, Owner: key, Board: "team-a", AnchorJSON: `{"whole":true}`, Body: "[Dana] Is Monday firm?", Source: store.ReviewDraftGdoc, SourceName: "Dana", SourceRef: "doc1|c1"})
	require.NoError(t, err)
	_, _, err = rig.ss.CreateReviewDraft(ctx, store.ReviewDraft{ArtifactID: cmtDoc, Owner: key, Board: "team-a", Body: "[Lee] Yes.", Source: store.ReviewDraftGdoc, SourceName: "Lee", SourceRef: "doc1|c1/r1"})
	require.NoError(t, err)
	rig.draft("My own note.", map[string]any{"whole": true})

	_, got := rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	var viaParent int
	for _, d := range got["drafts"].([]any) {
		if pd, ok := d.(map[string]any)["parent_draft_id"]; ok {
			assert.EqualValues(t, root.ID, pd)
			viaParent++
		}
	}
	assert.Equal(t, 1, viaParent, "the reply says which draft it answers")

	code, out := rig.sendDrafts("press-gdoc-1", got["revision"].(float64))
	require.Equal(t, http.StatusOK, code, "%v", out)
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1)
	assert.Contains(t, msgs[0].Content, "written by Dana in Google Docs")
	assert.Contains(t, msgs[0].Content, "written by Lee in Google Docs")
	assert.Contains(t, msgs[0].Content, "someone else's")
	assert.Contains(t, msgs[0].Content, "a reply in the thread of comment")

	_, list := rig.do(http.MethodGet, cp(cmtDoc), cmtAsOwner, nil)
	var kinds []string
	for _, c := range list["comments"].([]any) {
		kinds = append(kinds, c.(map[string]any)["author"].(map[string]any)["kind"].(string))
	}
	assert.ElementsMatch(t, []string{"google", "google", "owner"}, kinds, "the Google comments stay their authors' words; only my own note is the owner's")
	m, err := rig.ss.GdocCommentMap(ctx, "doc1")
	require.NoError(t, err)
	require.Contains(t, m, "c1")
	require.Contains(t, m, "c1/r1")
	assert.NotZero(t, m["c1"].CommentID)
	reply, found, err := rig.ss.GetArtifactComment(ctx, cmtDoc, m["c1/r1"].CommentID)
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, reply.ParentID)
	assert.Equal(t, m["c1"].CommentID, *reply.ParentID, "the imported reply is in the imported comment's thread")
}
