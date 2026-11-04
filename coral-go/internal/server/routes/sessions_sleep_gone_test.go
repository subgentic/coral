package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// #13171 (the Operator): an agent whose terminal is gone can be put to Sleep, not only woken. It is asleep already, so Sleep files it under plain sleeping: the reason "terminal_gone" is cleared (no more "Terminal gone"
// badge), its row and resume info stay, and a later wake resumes it like any sleeper. Sleep all terminal-gone does it for the agents named, or for every one; an archived agent, one whose CLI exited and an awake one are left alone.
func TestAnAgentWhoseTerminalIsGoneIsFiledUnderSleepingOneByOneOrInBulk(t *testing.T) {
	srv, _, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	resume := "11111111-1111-4111-8111-111111111111"
	add := func(id, name string, mod func(*store.LiveSession)) {
		ls := &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: name, WorkingDir: t.TempDir(), ResumeFromID: &resume}
		if mod != nil {
			mod(ls)
		}
		require.NoError(t, ss.RegisterLiveSession(ctx, ls))
	}
	const g = "00000000-0000-4000-8000-000000000010"
	const a, b, c, d, e, f = "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b", "00000000-0000-4000-8000-00000000000c", "00000000-0000-4000-8000-00000000000d", "00000000-0000-4000-8000-00000000000e", "00000000-0000-4000-8000-00000000000f"
	for id, name := range map[string]string{a: "A", b: "B", c: "C", d: "D", e: "E", f: "F", g: "G"} {
		add(id, name, nil)
	}
	for _, id := range []string{a, b, e, g} {
		require.NoError(t, ss.SetSessionSleepingFor(ctx, id, store.SleepReasonTerminalGone))
	}
	require.NoError(t, ss.SetSessionSleepingFor(ctx, f, store.SleepReasonAgentExited))
	require.NoError(t, ss.SetSessionSleeping(ctx, d, true))
	_, err := ss.DB().ExecContext(ctx, `UPDATE live_sessions SET is_archived = 1 WHERE session_id = ?`, e)
	require.NoError(t, err)

	state := func(id string) (sleeping bool, reason string, archived bool, ls *store.LiveSession) {
		ls, err := ss.GetLiveSession(ctx, id)
		require.NoError(t, err)
		require.NotNil(t, ls)
		return ls.IsSleeping == 1, ptr.Value(ls.SleepReason), ls.IsArchived == 1, ls
	}
	post := func(path, body string) (int, map[string]any) {
		resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(body))
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	// one by one: Sleep on A
	sl, reason, _, _ := state(a)
	require.True(t, sl)
	require.Equal(t, store.SleepReasonTerminalGone, reason)
	code, out := post("/api/sessions/live/"+a+"/sleep", "")
	require.Equal(t, http.StatusOK, code, "%v", out)
	sl, reason, _, row := state(a)
	assert.True(t, sl, "still asleep")
	assert.Equal(t, "", reason, "no longer 'terminal gone': plain sleeping")
	require.NotNil(t, row.ResumeFromID)
	assert.Equal(t, resume, *row.ResumeFromID, "its resume info is kept")

	// in bulk, naming agents: only the terminal-gone ones among them move
	code, out = post("/api/sessions/live/sleep-gone", `{"session_ids":["`+b+`","`+c+`","`+d+`","`+e+`","`+f+`"]}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.EqualValues(t, 1, out["sessions_affected"], "B moved; the awake, the plain sleeper, the archived and the exited were left")
	_, reason, _, _ = state(b)
	assert.Equal(t, "", reason)
	for id, want := range map[string]string{e: store.SleepReasonTerminalGone, f: store.SleepReasonAgentExited, g: store.SleepReasonTerminalGone} { // G is terminal-gone but was not named
		_, got, _, _ := state(id)
		assert.Equal(t, want, got, id)
	}
	sl, _, _, _ = state(c)
	assert.False(t, sl, "an awake agent stays awake")
	_, _, arch, _ := state(e)
	assert.True(t, arch)

	// in bulk, naming none: every terminal-gone agent (G and C; the archived E is not moved)
	require.NoError(t, ss.SetSessionSleepingFor(ctx, c, store.SleepReasonTerminalGone))
	code, out = post("/api/sessions/live/sleep-gone", ``)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.EqualValues(t, 2, out["sessions_affected"], "G and C; the archived E is not moved")
	_, reason, _, _ = state(c)
	assert.Equal(t, "", reason)
	_, reason, _, _ = state(e)
	assert.Equal(t, store.SleepReasonTerminalGone, reason)
	code, out = post("/api/sessions/live/sleep-gone", `{"session_ids":[]}`)
	require.Equal(t, http.StatusOK, code)
	assert.EqualValues(t, 0, out["sessions_affected"], "an empty list names no one")
	code, _ = post("/api/sessions/live/sleep-gone", `not json`)
	assert.Equal(t, http.StatusBadRequest, code)
}
