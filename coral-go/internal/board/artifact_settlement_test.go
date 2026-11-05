package board

import (
	"context"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestAutomaticSettlementCannotLoseItsActivityRow(t *testing.T) {
	s := activityStore(t)
	ctx := WithActivity(context.Background(), opMeta)
	old, newer := hexN(1), hexN(2)
	s.forReview(t, "alpha", old)
	s.forReview(t, "alpha", newer)
	before := s.ArtifactsRevision("alpha")
	// The Activity write must succeed with the review write, or neither happens.
	_, err := s.db.ExecContext(ctx, `CREATE TRIGGER refuse_settlement_activity BEFORE INSERT ON operator_actions BEGIN SELECT RAISE(FAIL, 'activity unavailable'); END`)
	require.NoError(t, err)
	changed, err := s.SettleOlderArtifactReview(ctx, "alpha", old, []string{newer}, time.Now())
	require.Error(t, err)
	require.False(t, changed)
	require.Equal(t, before, s.ArtifactsRevision("alpha"), "failed activity transaction cannot advertise a revision")
	tags, err := s.ArtifactTags(ctx, "alpha")
	require.NoError(t, err)
	require.Contains(t, tags[old], "for review")
	require.NotContains(t, tags[old], "superseded")
	_, err = s.db.ExecContext(ctx, `DROP TRIGGER refuse_settlement_activity`)
	require.NoError(t, err)
	changed, err = s.SettleOlderArtifactReview(ctx, "alpha", old, []string{newer}, time.Now())
	require.NoError(t, err)
	require.True(t, changed)
	require.Greater(t, s.ArtifactsRevision("alpha"), before, "committed settlement notifies after its activity row commits")
	rows, err := s.ListActivity(ctx, ActivityFilter{})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, ActSupersede, rows[0].Action)
	check, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	require.True(t, check.Intact)
}
