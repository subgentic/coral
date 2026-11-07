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
