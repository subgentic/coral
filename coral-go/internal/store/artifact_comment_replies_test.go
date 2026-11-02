package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	artC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	artD = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
)

// #12026 (the Operator): after the Operator comments on a file, an agent's reply in that thread is something waiting for them, until they open the thread. UnseenAgentReplies lists the threads the OWNER started
// that an agent has replied in since the owner last opened them, one row per thread; MarkThreadsSeen is the opening.
// stamp sets a comment's time (the store stamps its own) so the test can order the events.
func stamp(t *testing.T, s *SessionStore, id int64, at time.Time) {
	t.Helper()
	_, err := s.db.ExecContext(context.Background(), `UPDATE artifact_comments SET created_at = ? WHERE id = ?`, at.UTC().Format(ISOFormat), id)
	require.NoError(t, err)
}

func TestUnseenAgentRepliesAreTheOwnersThreadsAnAgentAnsweredSinceTheyWereOpened(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	owner := func(artifact string, at time.Time) ArtifactComment {
		c, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: artifact, Board: "team-a", Body: "please check", AuthorIssuer: "local", AuthorSubject: "u", AuthorKind: "owner", CreatedAt: at.Format(ISOFormat)})
		require.NoError(t, err)
		stamp(t, s, c.ID, at)
		return c
	}
	reply := func(root ArtifactComment, kind, who string, at time.Time) {
		c, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: root.ArtifactID, Board: "team-a", ParentID: &root.ID, Body: "done", AuthorIssuer: "agent", AuthorSubject: who, AuthorName: who, AuthorKind: kind})
		require.NoError(t, err)
		stamp(t, s, c.ID, at)
	}
	unseen := func() []CommentReply {
		got, err := s.UnseenAgentReplies(ctx)
		require.NoError(t, err)
		return got
	}

	thread := owner(artA, now)
	assert.Empty(t, unseen(), "a comment nobody answered waits for nobody")

	reply(thread, "agent", "Dev", now.Add(time.Minute))
	got := unseen()
	require.Len(t, got, 1, "an agent replied in the owner's thread")
	assert.Equal(t, thread.ID, got[0].RootID)
	assert.Equal(t, artA, got[0].ArtifactID)
	assert.Equal(t, "team-a", got[0].Board)
	assert.Equal(t, "Dev", got[0].Agent)
	assert.Equal(t, 1, got[0].Count)

	reply(thread, "agent", "QA", now.Add(2*time.Minute))
	got = unseen()
	require.Len(t, got, 1, "still ONE item for the thread")
	assert.Equal(t, "QA", got[0].Agent, "named by its newest reply")
	assert.Equal(t, 2, got[0].Count)

	require.NoError(t, s.MarkThreadsSeen(ctx, artA, now.Add(3*time.Minute)))
	assert.Empty(t, unseen(), "opening the thread reads it")

	reply(thread, "agent", "Dev", now.Add(4*time.Minute))
	got = unseen()
	require.Len(t, got, 1, "a reply after it was opened is unread again")
	assert.Equal(t, 1, got[0].Count, "only what came since")

	// what is not the owner's thread, or not an agent's reply, is not an item
	other := owner(artB, now)
	reply(other, "owner", "u", now.Add(time.Minute)) // the owner's own follow-up
	reply(other, "hub", "viewer", now.Add(time.Minute))
	var hubRoot ArtifactComment
	hubRoot, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: artC, Board: "team-a", Body: "hub person", AuthorIssuer: "hub", AuthorSubject: "v", AuthorKind: "hub"})
	require.NoError(t, err)
	stamp(t, s, hubRoot.ID, now)
	reply(hubRoot, "agent", "Dev", now.Add(time.Minute))
	for _, g := range unseen() {
		assert.Equal(t, thread.ID, g.RootID, "only the owner's thread an agent answered")
	}

	// a deleted reply, and a deleted thread, are not waiting
	require.NoError(t, s.MarkThreadsSeen(ctx, artA, now.Add(10*time.Minute)))
	reply(thread, "agent", "Dev", now.Add(11*time.Minute))
	require.Len(t, unseen(), 1)
	_, err = s.db.ExecContext(ctx, `UPDATE artifact_comments SET deleted_at = ? WHERE id = ?`, now.Format(ISOFormat), thread.ID)
	require.NoError(t, err)
	assert.Empty(t, unseen(), "a deleted thread is gone")

	// opening one file's thread does not read another's
	t2 := owner(artD, now)
	reply(t2, "agent", "Dev", now.Add(time.Minute))
	require.NoError(t, s.MarkThreadsSeen(ctx, artA, now.Add(time.Hour)))
	found := false
	for _, g := range unseen() {
		found = found || g.RootID == t2.ID
	}
	assert.True(t, found, "another file's thread stays unread")
}
