package store

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #6357 (#6443): an agent may reply only into a thread it was asked into, checked and counted in one step.

func TestAnAskIsOneRowPerCommentAndAgentAndAnOpenOneIsReturnedAsIs(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	now := time.Now()
	a, created, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-1", "Dev", now)
	require.NoError(t, err)
	assert.True(t, created)
	b, created, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-1", "Dev", now.Add(time.Minute))
	require.NoError(t, err)
	assert.False(t, created, "an open ask for the same comment and agent is returned as it is")
	assert.Equal(t, a.ID, b.ID)
	_, created, _ = s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-2", "QA", now)
	assert.True(t, created, "another agent, its own ask")
	_, created, _ = s.CreateArtifactAsk(ctx, 2, artA, "team-a", "sess-1", "Dev", now)
	assert.True(t, created, "another comment, its own ask")

	// after it expired it starts anew, with its replies counted from zero
	require.NoError(t, s.ReserveAskReply(ctx, 1, "sess-1", 10, now))
	later := now.Add(AskTTL + time.Second)
	c, created, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-1", "Dev", later)
	require.NoError(t, err)
	assert.True(t, created)
	assert.Equal(t, a.ID, c.ID)
	assert.Equal(t, 0, c.Replies)
	assert.True(t, c.OpenAt(later.Add(time.Hour)))
}

func TestAReplyIsCheckedAgainstTheAskInOneStep(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	now := time.Now()
	assert.ErrorIs(t, s.ReserveAskReply(ctx, 1, "sess-1", 10, now), ErrAskNone, "never asked")
	_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-1", "Dev", now)
	require.NoError(t, err)
	assert.ErrorIs(t, s.ReserveAskReply(ctx, 1, "sess-2", 10, now), ErrAskNone, "another agent was not asked")
	assert.ErrorIs(t, s.ReserveAskReply(ctx, 2, "sess-1", 10, now), ErrAskNone, "another thread")
	assert.ErrorIs(t, s.ReserveAskReply(ctx, 1, "sess-1", MaxAskReplyBytes+1, now), ErrAskReplyTooBig)
	for i := 0; i < MaxAskReplies; i++ {
		require.NoError(t, s.ReserveAskReply(ctx, 1, "sess-1", MaxAskReplyBytes, now), "reply %d", i+1)
	}
	assert.ErrorIs(t, s.ReserveAskReply(ctx, 1, "sess-1", 10, now), ErrAskReplyCap)
	s.ReleaseAskReply(ctx, 1, "sess-1") // a reply that was not stored is given back
	assert.NoError(t, s.ReserveAskReply(ctx, 1, "sess-1", 10, now))
	assert.ErrorIs(t, s.ReserveAskReply(ctx, 1, "sess-1", 10, now), ErrAskReplyCap)

	_, _, err = s.CreateArtifactAsk(ctx, 3, artA, "team-a", "sess-1", "Dev", now)
	require.NoError(t, err)
	assert.ErrorIs(t, s.ReserveAskReply(ctx, 3, "sess-1", 10, now.Add(AskTTL+time.Second)), ErrAskClosed, "expired")
	require.NoError(t, s.CloseArtifactAsks(ctx, 3, now))
	assert.ErrorIs(t, s.ReserveAskReply(ctx, 3, "sess-1", 10, now), ErrAskClosed, "closed")
}

func TestRepliesArrivingTogetherCannotPassTheCapBetweenThem(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	now := time.Now()
	_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-1", "Dev", now)
	require.NoError(t, err)
	var ok atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.ReserveAskReply(ctx, 1, "sess-1", 10, now) == nil {
				ok.Add(1)
			}
		}()
	}
	wg.Wait()
	assert.Equal(t, int32(MaxAskReplies), ok.Load(), "exactly the cap got through")
}

func TestDeletingAnArtifactsCommentsDropsItsAsks(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-1", "Dev", time.Now())
	require.NoError(t, err)
	_, _, err = s.CreateArtifactAsk(ctx, 2, artB, "team-a", "sess-1", "Dev", time.Now())
	require.NoError(t, err)
	_, err = s.DeleteArtifactComments(ctx, artA)
	require.NoError(t, err)
	_, found, _ := s.GetArtifactAsk(ctx, 1, "sess-1")
	assert.False(t, found)
	_, found, _ = s.GetArtifactAsk(ctx, 2, "sess-1")
	assert.True(t, found, "another artifact's ask stays")
}

// #17361: a new version of the file answers the question about the older one: the team's open asks on the older versions end, whichever of its agents they were put to; another team's stay.
func TestANewVersionClosesTheTeamsOpenAsksOnTheOlderVersions(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	now := time.Now()
	for _, c := range []struct {
		id           int64
		board, agent string
	}{{1, "team-a", "sess-1"}, {2, "team-a", "sess-2"}, {3, "team-b", "sess-3"}} {
		_, _, err := s.CreateArtifactAsk(ctx, c.id, artA, c.board, c.agent, "x", now)
		require.NoError(t, err)
	}
	require.NoError(t, s.CloseOpenAsksOfVersions(ctx, []string{artA}, "team-a", now.Add(time.Minute)))
	later := now.Add(2 * time.Minute)
	for id, agent := range map[int64]string{1: "sess-1", 2: "sess-2"} {
		a, _, _ := s.GetArtifactAsk(ctx, id, agent)
		assert.False(t, a.OpenAt(later), "the team's ask %d on the older version is answered", id)
	}
	b, _, _ := s.GetArtifactAsk(ctx, 3, "sess-3")
	assert.True(t, b.OpenAt(later), "another team's ask stays open")
}

// #19563: a comment held for a busy agent is not answered by an upload of the next version made during that turn: the ask stays open so the agent gets it when its turn ends, and a delivered ask still closes.
func TestANewVersionLeavesAHeldAskOpen(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	now := time.Now()
	for _, c := range []struct {
		id    int64
		agent string
	}{{1, "sess-held"}, {2, "sess-sent"}} {
		_, _, err := s.CreateArtifactAsk(ctx, c.id, artA, "team-a", c.agent, "x", now)
		require.NoError(t, err)
	}
	ok, err := s.HoldAskMessage(ctx, 1, "sess-held", "the Operator commented", false, now)
	require.NoError(t, err)
	require.True(t, ok)
	require.NoError(t, s.CloseOpenAsksOfVersions(ctx, []string{artA}, "team-a", now.Add(time.Minute)))
	later := now.Add(2 * time.Minute)
	held, _, _ := s.GetArtifactAsk(ctx, 1, "sess-held")
	assert.True(t, held.OpenAt(later), "the held comment is still waiting for its agent: it stays open")
	sent, _, _ := s.GetArtifactAsk(ctx, 2, "sess-sent")
	assert.False(t, sent.OpenAt(later), "an ask already delivered is answered by the new version")
}
