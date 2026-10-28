package routes

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #10315 (Beta #10305, Desktop recheck): agents in a folder, and a team's members, changed order after a restart and a sleep: the list put the awake agents before the sleeping ones, so a2 came above a1 when a1
// slept, or woke after a2. The order is the launch order whether an agent is awake or asleep (archived ones stay last).
func TestAgentsKeepTheirLaunchOrderWhetherAwakeOrAsleep(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	term := newMockTerminal()
	h := NewSessionsHandler(db, &config.Config{LogDir: t.TempDir(), CoralRoot: "/home/someone"}, nil, term, nil)
	ids := []string{"11111111-0000-0000-0000-00000000000a", "22222222-0000-0000-0000-00000000000b", "33333333-0000-0000-0000-00000000000c", "44444444-0000-0000-0000-00000000000d"}
	for _, sid := range ids { // launched in this order
		term.addSession("claude-"+sid, "/home/someone/proj")
		require.NoError(t, h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "a-" + sid[:1], WorkingDir: "/home/someone/proj"}))
	}
	order := func() []string {
		rows, err := h.buildSessionListForWS(httptest.NewRequest("GET", "/ws/coral", nil))
		require.NoError(t, err)
		h.orderLiveRows(ctx, rows)
		var got []string
		for _, r := range rows {
			got = append(got, r["session_id"].(string))
		}
		return got
	}
	assert.Equal(t, ids, order(), "all awake: the launch order")
	require.NoError(t, h.ss.SetSessionSleepingFor(ctx, ids[0], store.SleepReasonCoralStopped)) // Coral stopped: the first agent is asleep until it is woken, the others are awake
	require.NoError(t, h.ss.SetSessionSleeping(ctx, ids[2], true))                             // and one in the middle sleeps
	assert.Equal(t, ids, order(), "the sleeping keep their place among the awake")
	require.NoError(t, h.ss.SetSessionSleeping(ctx, ids[0], false))
	assert.Equal(t, ids, order(), "the first wakes after the others: still first")
	require.NoError(t, h.ss.SetSessionArchived(ctx, ids[1], true))
	assert.Equal(t, []string{ids[0], ids[2], ids[3], ids[1]}, order(), "an archived agent goes last, as before")
}
