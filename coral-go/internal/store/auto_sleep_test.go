package store_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

func autoSleepStore(t *testing.T) *store.SessionStore {
	t.Helper()
	db, err := storetest.Open(t, t.TempDir()+"/s.db")
	require.NoError(t, err)
	return store.NewSessionStore(db)
}

// An auto-sleep is one write: asleep with the reason idle and the sleep clock together; a row that is not awake any more is not touched and nothing is recorded.
func TestAutoSleepIsOneWriteAndOnlyOfAnAwakeAgent(t *testing.T) {
	ss := autoSleepStore(t)
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "a1", AgentType: "claude", AgentName: "a", WorkingDir: "/tmp"}))
	at := time.Unix(1_800_000_000, 0)
	require.NoError(t, ss.SetSessionAutoSleeping(ctx, "a1", at))
	ls, _ := ss.GetLiveSession(ctx, "a1")
	assert.Equal(t, 1, ls.IsSleeping)
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonIdle, *ls.SleepReason)
	st, err := ss.AutoSleepStateOf(ctx, "a1")
	require.NoError(t, err)
	assert.Equal(t, at.Unix(), st.SleptAt)
	assert.Zero(t, st.WokenAt)

	// asleep already (the person's Sleep came first): refused, and the person's reason stays
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "a2", AgentType: "claude", AgentName: "b", WorkingDir: "/tmp"}))
	require.NoError(t, ss.SetSessionSleeping(ctx, "a2", true))
	assert.ErrorIs(t, ss.SetSessionAutoSleeping(ctx, "a2", at), sql.ErrNoRows)
	ls, _ = ss.GetLiveSession(ctx, "a2")
	assert.Nil(t, ls.SleepReason, "a person's Sleep keeps its own (empty) reason")
	st, _ = ss.AutoSleepStateOf(ctx, "a2")
	assert.Zero(t, st.SleptAt, "nothing is recorded for a sleep that was not ours")
}

func TestAutoSleepClocksAndOptOut(t *testing.T) {
	ss := autoSleepStore(t)
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "a1", AgentType: "claude", AgentName: "a", WorkingDir: "/tmp"}))
	st, err := ss.AutoSleepStateOf(ctx, "a1")
	require.NoError(t, err)
	assert.Equal(t, store.AutoSleepState{}, st, "no row: on, nothing recorded")
	require.NoError(t, ss.SetAutoSleepOff(ctx, "a1", true))
	require.NoError(t, ss.SetSessionAutoSleeping(ctx, "a1", time.Unix(1000, 0)))
	require.NoError(t, ss.NoteAutoWoken(ctx, "a1", time.Unix(1300, 0)))
	st, _ = ss.AutoSleepStateOf(ctx, "a1")
	assert.Equal(t, store.AutoSleepState{Off: true, SleptAt: 1000, WokenAt: 1300}, st)
	require.NoError(t, ss.ClearAutoSleepClocks(ctx, "a1"))
	st, _ = ss.AutoSleepStateOf(ctx, "a1")
	assert.Equal(t, store.AutoSleepState{Off: true}, st, "a person's Sleep or Wake clears the guard and keeps the opt-out")
}
