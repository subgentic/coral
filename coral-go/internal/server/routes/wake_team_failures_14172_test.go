package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/naming"
)

// Wake Team says which members did not start and why (#14172): it used to answer ok with the team awake while every spawn had failed (the log said "pty spawn failed: session already exists" three times).
// A team where nobody started is not awake: ok false with the reasons; a team where some started says so and names the rest.
func TestWakeTeamNamesTheMembersThatDidNotStart(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	const team = "wake-fail"
	add := func(id, name string) {
		t.Helper()
		r.add(id, name, "", "", false)
		_, err := r.h.db.ExecContext(ctx, "UPDATE live_sessions SET board_name = ? WHERE session_id = ?", team, id)
		require.NoError(t, err)
		_, err = r.h.bs.Subscribe(ctx, team, naming.SubscriberID(name, "claude"), name, naming.SessionName("claude", id), nil, "mentions")
		require.NoError(t, err)
	}
	add(sid(91), "Dev One")
	add(sid(92), "Dev Two")
	wake := func() (int, map[string]any) {
		rec := httptest.NewRecorder()
		r.h.Wake(rec, dropAt2(httptest.NewRequest(http.MethodPost, "/wake", nil), map[string]string{"boardName": team}))
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return rec.Code, out
	}

	// nobody can start: a CLI that cannot run
	require.NoError(t, r.ss.SetSetting(ctx, "cli_path_claude", "/no/such/claude-cli"))
	code, out := wake()
	require.Equal(t, http.StatusOK, code)
	require.Equal(t, false, out["ok"], "a team where nobody started is not awake")
	require.Equal(t, true, out["sleeping"])
	failed, _ := out["failed"].([]any)
	require.Len(t, failed, 2)
	names := map[string]bool{}
	for _, f := range failed {
		fm := f.(map[string]any)
		names[fm["name"].(string)] = true
		require.NotEmpty(t, fm["error"])
		require.NotEmpty(t, fm["session_id"])
	}
	require.Equal(t, map[string]bool{"Dev One": true, "Dev Two": true}, names)
	require.Contains(t, out["error"], "No one in this team could be started")

	// one starts, one does not: ok, and the one that did not is named
	require.NoError(t, r.ss.SetSetting(ctx, "cli_path_claude", stubCLI(t)))
	_, err := r.h.db.ExecContext(ctx, "UPDATE live_sessions SET agent_type = 'codex' WHERE session_id = ?", sid(92))
	require.NoError(t, err)
	require.NoError(t, r.ss.SetSetting(ctx, "cli_path_codex", "/no/such/codex-cli")) // Dev Two's CLI cannot run; Dev One's can
	code, out = wake()
	require.Equal(t, http.StatusOK, code)
	require.Equal(t, true, out["ok"], "someone started")
	require.EqualValues(t, 1, out["sessions_relaunched"])
	failed, _ = out["failed"].([]any)
	require.Len(t, failed, 1)
	require.Equal(t, "Dev Two", failed[0].(map[string]any)["name"])
	require.Equal(t, sid(92), failed[0].(map[string]any)["session_id"])
	asleep, _ := r.asleep(sid(92))
	require.True(t, asleep, "the one that did not start is still asleep")
}

// Wake Team with no one asleep does not say the team is awake (#14208, the live reproduction): Kill All unregisters the agents and an agent that exited leaves a row Coral still lists as awake, so the
// team has no sleeping member to wake, and the answer used to be ok, sleeping false, nothing started. It now says why, in the dashboard's refusal path (as Sleep Team already does, #12417): a team
// whose members are all running is told so, and a board with no live agents is told they were ended and where to resume them.
func TestWakeTeamWithNoOneAsleepSaysSoInsteadOfAwake(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	const team = "wake-none"
	wake := func() map[string]any {
		rec := httptest.NewRecorder()
		r.h.Wake(rec, dropAt2(httptest.NewRequest(http.MethodPost, "/wake", nil), map[string]string{"boardName": team}))
		require.Equal(t, http.StatusOK, rec.Code)
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}

	// a board with nothing on it at all
	out := wake()
	require.Equal(t, false, out["ok"], "nothing was started: not awake")
	require.EqualValues(t, 0, out["sessions_relaunched"])
	require.Contains(t, out["error"], "no agents Coral can wake")

	// members Kill All ended: named, with what a Resume needs
	for i, name := range []string{"Ended One", "Ended Two"} {
		id := sid(97 + i)
		r.add(id, name, "", "", false)
		_, err := r.h.db.ExecContext(ctx, "UPDATE live_sessions SET board_name = ? WHERE session_id = ?", team, id)
		require.NoError(t, err)
		require.NoError(t, r.ss.UnregisterLiveSession(ctx, id)) // what Kill All does
	}
	out = wake()
	require.Equal(t, false, out["ok"], "ended members are not a team that is awake")
	require.Contains(t, out["error"], "Ended One and Ended Two were ended")
	require.Contains(t, out["error"], "Resume them")
	endedList, _ := out["ended"].([]any)
	require.Len(t, endedList, 2, "the ended members are listed so the dashboard can offer to resume each")
	first := endedList[0].(map[string]any)
	require.NotEmpty(t, first["session_id"])
	require.Equal(t, "claude", first["agent_type"])
	require.NotEmpty(t, first["name"])

	// every member is running: nothing to wake
	for i, name := range []string{"Dev One", "Dev Two"} {
		id := sid(95 + i)
		r.add(id, name, "", "", false)
		_, err := r.h.db.ExecContext(ctx, "UPDATE live_sessions SET board_name = ?, is_sleeping = 0 WHERE session_id = ?", team, id)
		require.NoError(t, err)
	}
	out = wake()
	require.Equal(t, false, out["ok"])
	require.Contains(t, out["error"], "No one in this team is asleep")

	// one asleep: it is woken and the answer is ok as before
	_, err := r.h.db.ExecContext(ctx, "UPDATE live_sessions SET is_sleeping = 1 WHERE session_id = ?", sid(96))
	require.NoError(t, err)
	require.NoError(t, r.ss.SetSetting(ctx, "cli_path_claude", stubCLI(t)))
	out = wake()
	require.Equal(t, true, out["ok"])
	require.EqualValues(t, 1, out["sessions_relaunched"])
}
