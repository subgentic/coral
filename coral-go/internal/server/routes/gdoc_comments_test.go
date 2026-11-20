package routes

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gdocsync"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

func gdocComment(id, who, text, quote string) gdocsync.Comment {
	c := gdocsync.Comment{ID: id, Content: text, Author: gdocsync.Author{DisplayName: who}}
	c.QuotedFileContent.Value = quote
	return c
}

func (g *gdocRig) threads(t *testing.T) []store.ArtifactComment {
	t.Helper()
	out, err := g.ss.ListArtifactComments(context.Background(), gdocV2, "all", nil)
	require.NoError(t, err)
	return out
}

// Slice D (#20011): a comment made in the Doc comes back on the artifact once, with the person's name and the text it is on, and nothing else of them.
func TestAGoogleCommentComesBackOnTheArtifactOnce(t *testing.T) {
	g := syncRig(t)
	g.pass(&gdocSyncState{}) // pushes v2 to doc1
	g.drive.comments = map[string][]gdocsync.Comment{"doc1": {gdocComment("c1", "Dana Reviewer", "Is Monday firm?", "The launch is on Monday.")}}
	g.pass(&gdocSyncState{})
	g.pass(&gdocSyncState{})
	got := g.threads(t)
	require.Len(t, got, 1, "added once, however many passes")
	assert.Equal(t, "[Dana Reviewer] Is Monday firm?", got[0].Body)
	assert.Equal(t, "Dana Reviewer via Google Docs", got[0].AuthorName)
	assert.Equal(t, "google", got[0].AuthorKind)
	var a map[string]any
	require.NoError(t, json.Unmarshal([]byte(got[0].AnchorJSON), &a))
	assert.Equal(t, "The launch is on Monday.", a["quote"], "it is on the same text")
	assert.NotContains(t, got[0].Body+got[0].AuthorName+got[0].AuthorSubject, "@", "no email address")
}

// A reply in the Doc is a reply in the thread, once; a resolve in Google resolves the thread and a reopen reopens it.
func TestGoogleRepliesAndResolveComeBack(t *testing.T) {
	g := syncRig(t)
	g.pass(&gdocSyncState{})
	cm := gdocComment("c1", "Dana", "Is Monday firm?", "")
	g.drive.comments = map[string][]gdocsync.Comment{"doc1": {cm}}
	g.pass(&gdocSyncState{})
	cm.Replies = []gdocsync.Reply{{ID: "r1", Content: "Yes.", Author: gdocsync.Author{DisplayName: "Lee"}}}
	cm.Resolved = true
	g.drive.comments["doc1"] = []gdocsync.Comment{cm}
	g.pass(&gdocSyncState{})
	g.pass(&gdocSyncState{})
	got := g.threads(t)
	require.Len(t, got, 2, "the comment and its reply, once")
	assert.NotNil(t, got[0].ResolvedAt, "resolved in Google: resolved here")
	require.NotNil(t, got[1].ParentID)
	assert.Equal(t, "[Lee] Yes.", got[1].Body)
	cm.Resolved = false
	g.drive.comments["doc1"] = []gdocsync.Comment{cm}
	g.pass(&gdocSyncState{})
	assert.Nil(t, g.threads(t)[0].ResolvedAt, "reopened in Google: reopened here")
}

// What comes from Google is redacted like any comment, and a paused Doc or a switch that is off pulls nothing.
func TestGoogleCommentsAreRedactedAndStopWithPauseAndTheSwitch(t *testing.T) {
	g := syncRig(t)
	g.pass(&gdocSyncState{})
	secret := "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
	g.drive.comments = map[string][]gdocsync.Comment{"doc1": {gdocComment("c1", "Dana", "use "+secret, "")}}
	_, err := g.ss.SetGdocShareState(context.Background(), gdocSid, store.GdocSharePaused)
	require.NoError(t, err)
	calls := g.drive.calls
	g.pass(&gdocSyncState{})
	assert.Equal(t, calls, g.drive.calls, "a paused Doc is not asked")
	_, err = g.ss.SetGdocShareState(context.Background(), gdocSid, store.GdocShareLive)
	require.NoError(t, err)
	require.NoError(t, g.ss.SetSetting(context.Background(), setreg.GdocShare, "false"))
	g.pass(&gdocSyncState{})
	assert.Equal(t, calls, g.drive.calls, "the switch off: no Google call")
	require.NoError(t, g.ss.SetSetting(context.Background(), setreg.GdocShare, "true"))
	g.pass(&gdocSyncState{})
	got := g.threads(t)
	require.Len(t, got, 1)
	assert.NotContains(t, got[0].Body, secret)
}

// The agent that uploaded the version is told, naming the Google author as the writer of untrusted data, with the reply command.
func TestANewGoogleCommentIsPassedToTheUploadingAgent(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	c, err := rig.ss.CreateArtifactComment(context.Background(), store.ArtifactComment{ArtifactID: cmtDoc, Board: "team-a", Body: "[Dana] Is Monday firm?", AuthorIssuer: "google-docs", AuthorSubject: "doc1", AuthorName: "Dana", AuthorKind: "google"})
	require.NoError(t, err)
	rig.h.noteGdocComment(context.Background(), seriesMember{Digest: cmtDoc, Board: "team-a"}, c, c.Body, "Dana")
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1)
	assert.Contains(t, msgs[0].Content, "@Dev ")
	assert.Contains(t, msgs[0].Content, "Is Monday firm?")
	assert.Contains(t, msgs[0].Content, "written by Dana")
	assert.Contains(t, msgs[0].Content, "coral-agent artifact reply")
}
