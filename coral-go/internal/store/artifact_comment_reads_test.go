package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14130: when an agent first read the board message that delivered a comment to it is kept on the ask (read_at), for that agent only, the first time only; the thread shows the earlier of it and seen_at.

func askOf(t *testing.T, s *SessionStore, comment int64, session string) ArtifactAsk {
	t.Helper()
	asks, err := s.ListArtifactAsks(context.Background(), artA)
	require.NoError(t, err)
	for _, a := range asks {
		if a.CommentID == comment && a.AgentSession == session {
			return a
		}
	}
	t.Fatalf("no ask for comment %d and %s", comment, session)
	return ArtifactAsk{}
}

func TestAnAgentsReadOfItsDeliveringMessageStampsItsAskOnceAndNobodyElses(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	for _, sess := range []string{"sess-dev", "sess-qa"} {
		_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", sess, sess, t0)
		require.NoError(t, err)
	}
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 101, 1, "sess-dev"))
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 102, 1, "sess-qa"))
	assert.Equal(t, "", askOf(t, s, 1, "sess-dev").ReadStamp(), "nothing read yet")

	// QA reads the message that was for Dev (a reader of everything does): no stamp for anyone
	n, err := s.MarkCommentMessagesRead(ctx, "team-a", "sess-qa", []int64{101}, t0.Add(time.Minute))
	require.NoError(t, err)
	assert.Zero(t, n, "a message for another agent stamps nothing")
	assert.Equal(t, "", askOf(t, s, 1, "sess-dev").ReadStamp())
	assert.Equal(t, "", askOf(t, s, 1, "sess-qa").ReadStamp())

	// Dev reads its own message (and an unrelated one): Dev's ask is stamped
	n, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{7, 101}, t0.Add(2*time.Minute))
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	first := askOf(t, s, 1, "sess-dev").ReadStamp()
	assert.Equal(t, t0.Add(2*time.Minute).UTC().Format(ISOFormat), first)
	assert.Equal(t, "", askOf(t, s, 1, "sess-qa").ReadStamp(), "QA's ask is untouched")

	// the first read wins
	n, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{101}, t0.Add(10*time.Minute))
	require.NoError(t, err)
	assert.Zero(t, n)
	assert.Equal(t, first, askOf(t, s, 1, "sess-dev").ReadStamp(), "a later read moves nothing")

	// another board's message of the same id is not this one
	n, _ = s.MarkCommentMessagesRead(ctx, "team-b", "sess-qa", []int64{102}, t0.Add(11*time.Minute))
	assert.Zero(t, n, "the link is per board")
	assert.Equal(t, "", askOf(t, s, 1, "sess-qa").ReadStamp())
}

func TestTheReadStampIsTheEarlierOfTheCommentsGetAndTheBoardRead(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-dev", "Dev", t0)
	require.NoError(t, err)
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 101, 1, "sess-dev"))

	// the comments GET came first (seen_at), the board read later: the earlier one is shown
	require.NoError(t, s.MarkAsksSeen(ctx, artA, "sess-dev", t0.Add(time.Minute)))
	_, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{101}, t0.Add(5*time.Minute))
	require.NoError(t, err)
	assert.Equal(t, t0.Add(time.Minute).UTC().Format(ISOFormat), askOf(t, s, 1, "sess-dev").ReadStamp())

	// and the other way round
	_, _, err = s.CreateArtifactAsk(ctx, 2, artA, "team-a", "sess-dev", "Dev", t0)
	require.NoError(t, err)
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 102, 2, "sess-dev"))
	_, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{102}, t0.Add(2*time.Minute))
	require.NoError(t, err)
	require.NoError(t, s.MarkAsksSeen(ctx, artA, "sess-dev", t0.Add(9*time.Minute)))
	assert.Equal(t, t0.Add(2*time.Minute).UTC().Format(ISOFormat), askOf(t, s, 2, "sess-dev").ReadStamp(), "the board read was first")
}

// An ask that ended and is asked again starts anew: the old read does not carry over.
func TestAnAskedAgainThreadStartsUnread(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-dev", "Dev", t0)
	require.NoError(t, err)
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 101, 1, "sess-dev"))
	_, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{101}, t0.Add(time.Minute))
	require.NoError(t, err)
	require.NotEmpty(t, askOf(t, s, 1, "sess-dev").ReadStamp())
	again, created, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-dev", "Dev", t0.Add(AskTTL+time.Second))
	require.NoError(t, err)
	require.True(t, created)
	assert.Equal(t, "", again.ReadStamp(), "a new ask is unread")
}
