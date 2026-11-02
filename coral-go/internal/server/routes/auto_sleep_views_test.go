package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// An auto-asleep agent (sleep_reason idle, #12111) is available everywhere a sleeper would be flagged: not in the set of sleeping subscribers the health check lists as "asleep with
// tasks", in the set of auto-asleep ones, and its board is not counted as all asleep (a pause on restart would hold the delivery that wakes it).
func TestAutoAsleepIsAvailableNotSleeping(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "autosleepviews"
	h.bs.SetSessionsDB(h.db.DB) // the health check's reader of which agents sleep
	mk := func(name, sid string, idle bool) {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: "claude", BoardName: &team, WorkingDir: "/tmp"}))
		if idle {
			require.NoError(t, ss.SetSessionAutoSleeping(ctx, sid, time.Now()))
		} else {
			require.NoError(t, ss.SetSessionSleeping(ctx, sid, true))
		}
		_, err := h.bs.Subscribe(ctx, team, name, "Developer", "claude-"+sid, nil, "all")
		require.NoError(t, err)
	}
	mk("manual", "00000000-0000-4000-8000-000000000001", false)
	mk("idle", "00000000-0000-4000-8000-000000000002", true)

	asleep, err := h.bs.SleepingSubscribers(ctx, team)
	require.NoError(t, err)
	auto, err := h.bs.AutoAsleepSubscribers(ctx, team)
	require.NoError(t, err)
	assert.True(t, asleep["manual"], "a person's Sleep is still asleep")
	assert.False(t, asleep["idle"], "an auto-asleep agent is not a sleeper to flag")
	assert.True(t, auto["idle"])
	assert.False(t, auto["manual"])

	// a board whose agents are all auto-asleep is not an asleep board (RestoreSleepingBoards would pause it); one with a person's Sleep is
	names, err := ss.GetSleepingBoardNames(ctx)
	require.NoError(t, err)
	assert.NotContains(t, names, team, "an auto-asleep agent counts as awake for the board's pause: one person's Sleep beside it does not make the board asleep")
}

func TestAllAutoAsleepBoardIsNotAnAsleepBoard(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "onlyidle"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "00000000-0000-4000-8000-000000000003", AgentName: "a", AgentType: "claude", BoardName: &team, WorkingDir: "/tmp"}))
	require.NoError(t, ss.SetSessionAutoSleeping(ctx, "00000000-0000-4000-8000-000000000003", time.Now()))
	_ = h
	names, err := ss.GetSleepingBoardNames(ctx)
	require.NoError(t, err)
	assert.NotContains(t, names, team, "every agent auto-asleep: the board stays unpaused, so a message can wake them")
}

// The live list says auto_asleep for an agent put to sleep for being idle, and not for a person's Sleep.
func TestLiveListSaysAutoAsleep(t *testing.T) {
	server, _, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	for sid, idle := range map[string]bool{"00000000-0000-4000-8000-0000000000a1": true, "00000000-0000-4000-8000-0000000000a2": false} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "a-" + sid[len(sid)-2:], AgentType: "claude", WorkingDir: "/tmp"}))
		if idle {
			require.NoError(t, ss.SetSessionAutoSleeping(ctx, sid, time.Now()))
		} else {
			require.NoError(t, ss.SetSessionSleeping(ctx, sid, true))
		}
	}
	resp, err := http.Get(server.URL + "/api/sessions/live")
	require.NoError(t, err)
	defer resp.Body.Close()
	var rows []map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
	got := map[string]any{}
	for _, r := range rows {
		got[r["session_id"].(string)] = r["auto_asleep"]
	}
	assert.Equal(t, true, got["00000000-0000-4000-8000-0000000000a1"])
	assert.Equal(t, false, got["00000000-0000-4000-8000-0000000000a2"])
}
