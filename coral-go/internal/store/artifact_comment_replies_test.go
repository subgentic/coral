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

func TestMarkThreadsSeenChangedOnlyWritesForUnreadReplies(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	base := time.Now().UTC().Truncate(time.Second)
	root, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: artA, Board: "team-a", Body: "check", AuthorKind: "owner"})
	require.NoError(t, err)
	changed, err := s.MarkThreadsSeenChanged(ctx, artA, base)
	require.NoError(t, err)
	require.False(t, changed)
	var count int
	require.NoError(t, s.db.GetContext(ctx, &count, `SELECT COUNT(*) FROM artifact_comment_seen`))
	require.Zero(t, count, "a no-op read must not add seen records")
	reply, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: artA, Board: "team-a", ParentID: &root.ID, Body: "done", AuthorKind: "agent"})
	require.NoError(t, err)
	stamp(t, s, reply.ID, base.Add(time.Minute))
	changed, err = s.MarkThreadsSeenChanged(ctx, artA, base.Add(2*time.Minute))
	require.NoError(t, err)
	require.True(t, changed)
	var before, after string
	require.NoError(t, s.db.GetContext(ctx, &before, `SELECT seen_at FROM artifact_comment_seen WHERE comment_id = ?`, root.ID))
	changed, err = s.MarkThreadsSeenChanged(ctx, artA, base.Add(3*time.Minute))
	require.NoError(t, err)
	require.False(t, changed)
	require.NoError(t, s.db.GetContext(ctx, &after, `SELECT seen_at FROM artifact_comment_seen WHERE comment_id = ?`, root.ID))
	require.Equal(t, before, after, "unchanged polling must not keep rewriting seen_at")
	news, err := s.UnseenAgentReplies(ctx)
	require.NoError(t, err)
	require.Empty(t, news)
}

func TestMarkThreadsSeenChangedComparesInstantsAndIsArtifactScoped(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	base := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	for _, id := range []string{artA, artB} {
		root, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: id, Body: "check", AuthorKind: "owner"})
		require.NoError(t, err)
		reply, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: id, ParentID: &root.ID, Body: "done", AuthorKind: "agent"})
		require.NoError(t, err)
		// Lexical RFC3339 order would put this newer fractional timestamp before Z.
		_, err = s.db.ExecContext(ctx, `UPDATE artifact_comments SET created_at = ? WHERE id = ?`, base.Add(time.Nanosecond).Format(time.RFC3339Nano), reply.ID)
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `INSERT INTO artifact_comment_seen(comment_id,seen_at) VALUES(?,?)`, root.ID, base.Format(time.RFC3339))
		require.NoError(t, err)
	}
	changed, err := s.MarkThreadsSeenChanged(ctx, artA, base.Add(2*time.Microsecond))
	require.NoError(t, err)
	require.True(t, changed)
	changed, err = s.MarkThreadsSeenChanged(ctx, artA, base.Add(3*time.Microsecond))
	require.NoError(t, err)
	require.False(t, changed)
	news, err := s.UnseenAgentReplies(ctx)
	require.NoError(t, err)
	require.Len(t, news, 1)
	require.Equal(t, artB, news[0].ArtifactID)
}

func TestMarkThreadsSeenChangedConcurrentReadersReportOneChange(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	root, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: artA, Body: "check", AuthorKind: "owner"})
	require.NoError(t, err)
	_, err = s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: artA, ParentID: &root.ID, Body: "done", AuthorKind: "agent"})
	require.NoError(t, err)
	type result struct {
		changed bool
		err     error
	}
	results := make(chan result, 2)
	now := time.Now().Add(time.Second)
	for i := 0; i < 2; i++ {
		go func() { changed, err := s.MarkThreadsSeenChanged(ctx, artA, now); results <- result{changed, err} }()
	}
	changes := 0
	for i := 0; i < 2; i++ {
		r := <-results
		require.NoError(t, r.err)
		if r.changed {
			changes++
		}
	}
	require.Equal(t, 1, changes, "only one concurrent reader actually clears the unread reply")
}
