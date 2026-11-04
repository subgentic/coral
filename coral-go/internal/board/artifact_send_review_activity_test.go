package board

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Security's SHOULD on #13231: the Operator's send and take-out and their rows in the Activity record are one transaction: a row that cannot be written undoes the send (and the take-out), and the two stand together.
func TestASendForReviewAndItsActivityRowStandOrFallTogether(t *testing.T) {
	s := testStore(t)
	ctx := WithActivity(context.Background(), ActivityMeta{Actor: "local", Source: "local", Title: "plan.md", Note: "Ship it?"})
	hex := strings.Repeat("c", 64)
	rows := func() []OperatorAction {
		r, err := s.ListActivity(context.Background(), ActivityFilter{Limit: 50})
		require.NoError(t, err)
		return r
	}
	tags := func() []string {
		all, err := s.ArtifactTags(context.Background(), "team")
		require.NoError(t, err)
		return all[hex]
	}
	sent := func() bool {
		m, err := s.ArtifactReviewSent(context.Background(), "team")
		require.NoError(t, err)
		_, ok := m[hex]
		return ok
	}

	// the record cannot be written: nothing was sent
	_, err := s.db.ExecContext(context.Background(), `CREATE TRIGGER no_activity BEFORE INSERT ON operator_actions BEGIN SELECT RAISE(ABORT, 'cannot record'); END`)
	require.NoError(t, err)
	_, _, err = s.StartArtifactReview(ctx, "team", hex, time.Now())
	require.Error(t, err, "the row could not be written")
	assert.Empty(t, tags(), "so the send was undone: no tag")
	assert.False(t, sent(), "and no time")
	assert.Empty(t, rows())
	_, err = s.db.ExecContext(context.Background(), `DROP TRIGGER no_activity`)
	require.NoError(t, err)

	// both are written together
	got, was, err := s.StartArtifactReview(ctx, "team", hex, time.Now())
	require.NoError(t, err)
	assert.Equal(t, []string{"for review"}, got)
	assert.Equal(t, "", was)
	require.Len(t, rows(), 1)
	assert.Equal(t, ActSendReview, rows()[0].Action)
	assert.Equal(t, "Ship it?", rows()[0].Note)

	// the take-out: a row that cannot be written leaves the file for review
	_, err = s.db.ExecContext(context.Background(), `CREATE TRIGGER no_activity BEFORE INSERT ON operator_actions BEGIN SELECT RAISE(ABORT, 'cannot record'); END`)
	require.NoError(t, err)
	require.Error(t, s.TakeArtifactOutOfReview(ctx, "team", hex, []string{"for review"}, nil))
	assert.Equal(t, []string{"for review"}, tags(), "the take-out was undone with its row")
	_, err = s.db.ExecContext(context.Background(), `DROP TRIGGER no_activity`)
	require.NoError(t, err)
	require.NoError(t, s.TakeArtifactOutOfReview(ctx, "team", hex, []string{"for review"}, nil))
	assert.Empty(t, tags())
	require.Len(t, rows(), 2)
	assert.Equal(t, ActUnsendReview, rows()[0].Action)

	// without the Operator's context (no meta) no row is written and nothing fails: the store is used by others
	_, _, err = s.StartArtifactReview(context.Background(), "team", hex, time.Now())
	require.NoError(t, err)
	assert.Len(t, rows(), 2)
}
