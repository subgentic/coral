package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19916: the Operator's comments sent to an agent that it has not answered, for Inbox tab 2.
func TestWaitingCommentsAreTheOperatorsCommentsAnAgentHasNotAnsweredInTheThread(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	owner := func(artifact string, parent *int64, body string) ArtifactComment {
		c, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: artifact, Board: "team-a", ParentID: parent, Body: body, AuthorIssuer: "local", AuthorSubject: "u", AuthorKind: "owner"})
		require.NoError(t, err)
		return c
	}
	ask := func(c ArtifactComment, session, name string, at time.Time) {
		_, _, err := s.CreateArtifactAsk(ctx, c.ID, c.ArtifactID, "team-a", session, name, at)
		require.NoError(t, err)
	}
	agentReply := func(root ArtifactComment, at time.Time) {
		c, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: root.ArtifactID, Board: "team-a", ParentID: &root.ID, Body: "done", AuthorIssuer: "agent", AuthorSubject: "Dev", AuthorName: "Dev", AuthorKind: "agent"})
		require.NoError(t, err)
		stamp(t, s, c.ID, at)
	}

	waiting := owner(artA, nil, "is this the final one?")
	ask(waiting, "sess-dev", "Dev", now.Add(-3*time.Hour))
	answered := owner(artC, nil, "fix the title")
	ask(answered, "sess-dev", "Dev", now.Add(-2*time.Hour))
	agentReply(answered, now.Add(-time.Hour))
	older := owner(artD, nil, "an older reply, unanswered")
	ask(older, "sess-qa", "QA", now.Add(-5*time.Hour))
	resolved := owner("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", nil, "resolved by hand")
	ask(resolved, "sess-dev", "Dev", now.Add(-time.Hour))
	require.NoError(t, s.CloseArtifactAsks(ctx, resolved.ID, now))
	_ = owner("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", nil, "never sent to anyone")

	got, err := s.WaitingComments(ctx, now, 7*24*time.Hour)
	require.NoError(t, err)
	require.Len(t, got, 2, "an answered thread, a closed ask and a comment sent to nobody are not waiting")
	assert.Equal(t, older.ID, got[0].CommentID, "oldest first")
	assert.Equal(t, "QA", got[0].AgentName)
	assert.Equal(t, "an older reply, unanswered", got[0].Body)
	assert.WithinDuration(t, now.Add(-5*time.Hour), got[0].Since, time.Second)
	assert.Equal(t, waiting.ID, got[1].CommentID)
	assert.Equal(t, "sess-dev", got[1].AgentSession)

	// a second comment in the same thread to the same agent is the same row (the newest), not two
	second := owner(artA, &waiting.ID, "any news?")
	ask(second, "sess-dev", "Dev", now.Add(-time.Hour))
	got, err = s.WaitingComments(ctx, now, 7*24*time.Hour)
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, second.ID, got[1].CommentID)

	// the agent replies after the ask: the thread is no longer waiting
	agentReply(waiting, now.Add(-30*time.Minute))
	got, err = s.WaitingComments(ctx, now, 7*24*time.Hour)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, older.ID, got[0].CommentID)

	// asked longer ago than the span: left alone
	got, err = s.WaitingComments(ctx, now, time.Hour*4)
	require.NoError(t, err)
	assert.Empty(t, got)
}

// #19923: the reply scan reads only the threads of the asks in the window, in chunks that fit SQLite's variable limit, so more than one chunk of waiting threads is still read right.
func TestWaitingCommentsReadsMoreThreadsThanOneChunkAndSkipsOldThreadsReplies(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	const n = 1100
	var answeredRoot int64
	for i := 0; i < n; i++ {
		art := fmt.Sprintf("%064x", i+1) // a file each: one file holds at most MaxArtifactComments comments
		c, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: art, Board: "team-a", Body: "c", AuthorIssuer: "local", AuthorSubject: "u", AuthorKind: "owner"})
		require.NoError(t, err)
		_, _, err = s.CreateArtifactAsk(ctx, c.ID, art, "team-a", "sess-dev", "Dev", now.Add(-time.Hour+time.Duration(i)*time.Millisecond))
		require.NoError(t, err)
		if i == n-1 {
			answeredRoot = c.ID
			r, err := s.CreateArtifactComment(ctx, ArtifactComment{ArtifactID: art, Board: "team-a", ParentID: &c.ID, Body: "done", AuthorKind: "agent"})
			require.NoError(t, err)
			stamp(t, s, r.ID, now)
		}
	}
	got, err := s.WaitingComments(ctx, now, 7*24*time.Hour)
	require.NoError(t, err)
	// one ask per (artifact, agent, thread): each of the 1100 comments is its own thread; the last one was answered, even though its thread is past the first chunk
	require.Len(t, got, n-1)
	for _, w := range got {
		require.NotEqual(t, answeredRoot, w.CommentID)
	}
}
