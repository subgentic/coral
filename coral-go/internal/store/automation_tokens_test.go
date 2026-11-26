package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAnAutomationTokenIsBoundToItsRunAndEndsWithIt(t *testing.T) {
	ctx := context.Background()
	db, err := OpenWithKey(ctx, filepath.Join(t.TempDir(), "a.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	now := time.Now()
	spec := AutomationTokenSpec{RunID: 5, WorkflowID: 2, WorkflowName: "prod-alerts", Project: "ops", TTL: time.Minute}
	tok, err := db.MintAutomationToken(ctx, spec, now)
	require.NoError(t, err)
	assert.Contains(t, tok, "au1.")
	o, err := db.AutomationTokenOf(ctx, tok, now)
	require.NoError(t, err)
	assert.Equal(t, AutomationTokenOwner{RunID: 5, WorkflowID: 2, WorkflowName: "prod-alerts", Project: "ops"}, *o)

	_, err = db.AutomationTokenOf(ctx, "au1.nope", now)
	assert.ErrorIs(t, err, ErrUnknownAutomationToken)
	_, err = db.AutomationTokenOf(ctx, tok, now.Add(2*time.Minute))
	assert.ErrorIs(t, err, ErrUnknownAutomationToken, "it expires")
	require.NoError(t, db.RevokeAutomationToken(ctx, tok, now))
	_, err = db.AutomationTokenOf(ctx, tok, now)
	assert.ErrorIs(t, err, ErrUnknownAutomationToken, "it ends with its run")

	for _, bad := range []AutomationTokenSpec{{WorkflowID: 2, WorkflowName: "x", Project: "p", TTL: time.Minute}, {RunID: 1, WorkflowName: "x", Project: "p", TTL: time.Minute},
		{RunID: 1, WorkflowID: 2, Project: "p", TTL: time.Minute}, {RunID: 1, WorkflowID: 2, WorkflowName: "x", TTL: time.Minute}, {RunID: 1, WorkflowID: 2, WorkflowName: "x", Project: "p"}} {
		_, err := db.MintAutomationToken(ctx, bad, now)
		assert.Error(t, err, "a token needs a run, a workflow, a team and a lifetime: %+v", bad)
	}

	a, _ := db.MintAutomationToken(ctx, spec, now)
	b, _ := db.MintAutomationToken(ctx, AutomationTokenSpec{RunID: 6, WorkflowID: 3, WorkflowName: "other", Project: "ops", TTL: time.Minute}, now)
	require.NoError(t, db.RevokeAutomationTokensForWorkflow(ctx, 2, now))
	_, err = db.AutomationTokenOf(ctx, a, now)
	assert.Error(t, err, "a workflow's tokens end when it is changed")
	_, err = db.AutomationTokenOf(ctx, b, now)
	assert.NoError(t, err, "another workflow's stay")
	require.NoError(t, db.RevokeAllAutomationTokens(ctx, now))
	_, err = db.AutomationTokenOf(ctx, b, now)
	assert.Error(t, err, "Coral's start ends every token")
}

func TestAnAutomationMayPostTwentyTimesARunAndSixtyAnHour(t *testing.T) {
	ctx := context.Background()
	db, err := OpenWithKey(ctx, filepath.Join(t.TempDir(), "a.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	now := time.Now()
	var last string
	for run := 1; run <= 4; run++ {
		tok, err := db.MintAutomationToken(ctx, AutomationTokenSpec{RunID: int64(run), WorkflowID: 9, WorkflowName: "w", Project: "p", TTL: time.Hour}, now)
		require.NoError(t, err)
		last = tok
		for i := 0; i < AutomationWritesPerRun; i++ {
			ok, err := db.TakeAutomationWrite(ctx, tok, now)
			require.NoError(t, err)
			if run*AutomationWritesPerRun <= AutomationWritesPerHour {
				assert.True(t, ok, "run %d post %d", run, i+1)
			}
		}
		if run*AutomationWritesPerRun <= AutomationWritesPerHour {
			ok, _ := db.TakeAutomationWrite(ctx, tok, now)
			assert.False(t, ok, "the 21st post of a run is refused")
		}
	}
	ok, err := db.TakeAutomationWrite(ctx, last, now)
	require.NoError(t, err)
	assert.False(t, ok, "past 60 in the hour for the workflow, a new run is refused too")
	ok, _ = db.TakeAutomationWrite(ctx, last, now.Add(2*time.Hour))
	assert.False(t, ok, "an expired token takes nothing")
}
