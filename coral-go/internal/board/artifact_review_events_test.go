package board

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15996 (coral-hub #208896): the session feed tells the Hub when an artifact is tagged or untagged "for review": its id and tagged true/false, nothing else.

func evHex(n int) string { return fmt.Sprintf("%064x", n) }

func reviewEventsSince(t *testing.T, s *Store, seq int64) ([]ForReviewEvent, int64) {
	t.Helper()
	ev, now, gap := s.ForReviewEventsSince(seq)
	assert.False(t, gap)
	return ev, now
}

func TestForReviewEventsGoOutOnTagAndUntagAndCarryNothingElse(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seq := s.ForReviewSeq() // a feed attaches
	obj := evHex(1)

	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"internal", "for review"}))
	ev, seq := reviewEventsSince(t, s, seq)
	require.Len(t, ev, 1)
	assert.Equal(t, ForReviewEvent{Artifact: obj, Tagged: true, Seq: ev[0].Seq}, ev[0])

	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"internal"}))
	ev, _ = reviewEventsSince(t, s, seq)
	require.Len(t, ev, 1)
	assert.Equal(t, obj, ev[0].Artifact)
	assert.False(t, ev[0].Tagged, "untagged")

	// on the wire: exactly the artifact id and tagged, no name, no text, no board, no counter
	b, err := json.Marshal(ev[0])
	require.NoError(t, err)
	assert.JSONEq(t, `{"artifact":"`+obj+`","tagged":false}`, string(b))
}

func TestForReviewEventsAreOnlyForRealChanges(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	obj := evHex(2)
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"for review"})) // before any feed: nothing is kept
	seq := s.ForReviewSeq()
	ev, _ := reviewEventsSince(t, s, 0)
	assert.Empty(t, ev, "what was tagged before the feed attached is not an event: the Hub reads the artifacts when it connects")

	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"for review"}))             // the same tags saved again
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", evHex(3), []string{"internal", "final"})) // another tag
	_, err := s.AddArtifactTags(ctx, "alpha", obj, []string{"draft"})                            // another tag added to the tagged one
	require.NoError(t, err)
	ev, seq = reviewEventsSince(t, s, seq)
	assert.Empty(t, ev, "no change of the tag, no event")

	have, err := s.AddArtifactTags(ctx, "alpha", evHex(4), []string{"for review"})
	require.NoError(t, err)
	assert.Contains(t, have, "for review")
	ev, _ = reviewEventsSince(t, s, seq)
	require.Len(t, ev, 1)
	assert.Equal(t, ForReviewEvent{Artifact: evHex(4), Tagged: true, Seq: ev[0].Seq}, ev[0], "a manifest's tag is an event too")
}

func TestForReviewEventsFollowADecisionAndABoardDeleted(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	obj := evHex(5)
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"for review"}))
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", evHex(6), []string{"for review"}))
	seq := s.ForReviewSeq()

	_, _, err := s.DecideArtifactReview(ctx, "alpha", obj, ReviewDenied, time.Now())
	require.NoError(t, err)
	ev, seq := reviewEventsSince(t, s, seq)
	require.Len(t, ev, 1)
	assert.Equal(t, ForReviewEvent{Artifact: obj, Tagged: false, Seq: ev[0].Seq}, ev[0], "a denial takes the file out of review")

	_, err = s.Subscribe(ctx, "alpha", "A", "Dev", "a-session", nil, "all")
	require.NoError(t, err)
	require.NoError(t, s.DeleteProject(ctx, "alpha"))
	ev, _ = reviewEventsSince(t, s, seq)
	require.Len(t, ev, 1)
	assert.Equal(t, ForReviewEvent{Artifact: evHex(6), Tagged: false, Seq: ev[0].Seq}, ev[0], "a board deleted takes its tags: the Hub is told each file left review")
}

func TestForReviewEventsSaysWhenAConnectionMissedSome(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	seq := s.ForReviewSeq()
	for i := 0; i < forReviewKeep+10; i++ {
		require.NoError(t, s.SetArtifactTags(ctx, "alpha", evHex(1000+i), []string{"for review"}))
	}
	ev, now, gap := s.ForReviewEventsSince(seq)
	assert.True(t, gap, "more happened than are kept: the Hub reads the list again")
	assert.Len(t, ev, forReviewKeep)
	assert.Equal(t, int64(forReviewKeep+10), now)

	ev, _, gap = s.ForReviewEventsSince(now - 3)
	assert.False(t, gap)
	assert.Len(t, ev, 3)
}

func TestForReviewEventsWakeTheFeedOnce(t *testing.T) {
	s := testStore(t)
	var woke int
	s.SetForReviewNotify(func() { woke++ })
	s.ForReviewSeq()
	require.NoError(t, s.SetArtifactTags(context.Background(), "alpha", evHex(7), []string{"for review"}))
	assert.Equal(t, 1, woke)
	require.NoError(t, s.SetArtifactTags(context.Background(), "alpha", evHex(7), []string{"for review"}))
	assert.Equal(t, 1, woke, "a save that changes nothing wakes nothing")
}
