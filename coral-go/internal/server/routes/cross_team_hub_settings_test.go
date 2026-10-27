package routes

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
)

// #7329 (the operator's decision of 2026-10-24: Coral Hub is the authority for cross-team settings): through the Hub the OWNER of this computer sets cross_team_messaging, cross_team_servers,
// cross_team_allowed and cross_team_artifacts on PUT /api/board/{project}/settings, under the local lock, the rate limit, a record that names the hub user and a notice on the board. Everyone else is refused, and
// require_goal is the owner's through the Hub too. These replace the tests that pinned local_only for the owner (#3377, #4379).

func hubSettingsEnv(t *testing.T, lockOn bool) (*BoardHandler, string) {
	t.Helper()
	_, h := setupBoardTestServer(t)
	withLabel(t, ownerLabel, nil)
	h.hubCrossTeamLock = func(context.Context) (bool, error) { return lockOn, nil }
	_, err := h.bs.Subscribe(context.Background(), "team", "Dev", "Developer", "dev-session", nil, "all")
	require.NoError(t, err)
	return h, "x-" + strings.Repeat("q", 16)
}

func TestTheOwnerThroughTheHubSetsTheCrossTeamSettingsAndItIsRecorded(t *testing.T) {
	h, other := hubSettingsEnv(t, true)
	ctx := context.Background()
	code, _ := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":false,"cross_team_artifacts":false}`, nil) // this computer: both start off
	require.Equal(t, 200, code)
	body := `{"subscriber_id":"Operator","cross_team_messaging":true,"cross_team_artifacts":true,"cross_team_servers":["srv_abc"],"cross_team_allowed":[{"server":"local","cross_team_id":"` + other + `"}]}`
	code, out := boardCall(t, h, http.MethodPut, body, ownerHeaders(ownerLabel))
	require.Equal(t, 200, code, "%v", out)
	set, err := h.bs.GetBoardSettings(ctx, "team")
	require.NoError(t, err)
	assert.True(t, set.CrossTeamMessaging)
	assert.True(t, set.CrossTeamArtifacts)
	assert.Equal(t, []string{"srv_abc"}, set.CrossTeamServers)
	require.Len(t, set.CrossTeamAllowed, 1)

	// Recorded, with the hub user: the switch log (via hub), the settings log (the hub user as the actor) and the Operator-actions row, in one transaction.
	last, err := h.bs.LastSwitchChanges(ctx, "team")
	require.NoError(t, err)
	for _, key := range []string{board.SwitchMessaging, board.SwitchFiles} {
		assert.Equal(t, board.SwitchViaHub, last[key].Via, key)
		assert.Equal(t, ownerLabel, last[key].Who, key)
		assert.True(t, last[key].New, key)
	}
	log, err := h.bs.ListLog(ctx, "team")
	require.NoError(t, err)
	fields := map[string]string{}
	for _, e := range log {
		if e.Kind == board.LogEdit {
			fields[e.Field] = e.Actor
		}
	}
	assert.Equal(t, ownerLabel, fields["cross_team_allowed"])
	assert.Equal(t, ownerLabel, fields["cross_team_servers"])
	actions, err := h.bs.RecentHubOperatorActions(ctx, 5)
	require.NoError(t, err)
	require.NotEmpty(t, actions)
	assert.Equal(t, ownerLabel, actions[0].HubUser)
	assert.Equal(t, "PUT", actions[0].Method)

	// A notice on the board in fixed words, naming the hub user and no value.
	msgs, err := h.bs.ListMessages(ctx, "team", 50, 0, 0)
	require.NoError(t, err)
	var notices []string
	for _, m := range msgs {
		if m.Origin != nil && *m.Origin == board.OriginHubNotice {
			notices = append(notices, m.Content)
		}
	}
	require.Len(t, notices, 4, "one for each switch and each edit: %v", notices)
	for _, n := range notices {
		assert.Contains(t, n, ownerLabel)
		assert.NotContains(t, n, other, "no list entry in a notice")
		assert.NotContains(t, n, "srv_abc")
	}

	// A request for the value a switch already has changes nothing and records no switch change.
	code, _ = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 200, code)

	// The list is still checked as a whole, through the Hub too.
	code, out = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_allowed":[{"server":"local","cross_team_id":"a name"}]}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 400, code)
	assert.Equal(t, "bad_allowlist", out["code"])
	// and so are the server ids.
	code, _ = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_servers":["not a server id"]}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 400, code)
}

func TestNobodyButTheOwnerChangesCrossTeamSettingsThroughTheHub(t *testing.T) {
	h, other := hubSettingsEnv(t, true)
	ctx := context.Background()
	before, err := h.bs.GetBoardSettings(ctx, "team")
	require.NoError(t, err)
	forged := ownerHeaders(ownerLabel)
	forged["X-Coral-Via"] = "1"
	noMarker := ownerHeaders(ownerLabel)
	delete(noMarker, "X-Coral-Hub-Role")
	bodies := []string{`"cross_team_messaging": true`, `"cross_team_servers": ["srv_abc"]`, `"cross_team_artifacts": true`,
		`"cross_team_allowed":[{"server":"local","cross_team_id":"` + other + `"}]`, `"cross_team_messaging": true, "health": {"on": false}`}
	for name, hdr := range map[string]map[string]string{"a grantee": granteeHeaders(), "another label": ownerHeaders("hub-user-9999ffff"), "no marker": noMarker} {
		for _, f := range bodies {
			code, out := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator",`+f+`}`, hdr)
			assert.Equal(t, 403, code, name+" "+f)
			assert.Equal(t, "owner_only", out["code"], name+" "+f)
		}
	}
	after, err := h.bs.GetBoardSettings(ctx, "team")
	require.NoError(t, err)
	assert.Equal(t, before, after, "nothing of a refused request is saved")
	actions, _ := h.bs.RecentHubOperatorActions(ctx, 5)
	assert.Empty(t, actions, "a refusal records no change")

	// require_goal is the owner's through the Hub too, and nobody else's (#7329).
	for name, hdr := range map[string]map[string]string{"a grantee": granteeHeaders(), "another label": ownerHeaders("hub-user-9999ffff"), "no marker": noMarker} {
		code, out := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","require_goal":true}`, hdr)
		assert.Equal(t, 403, code, name)
		assert.Equal(t, "owner_only", out["code"], name)
	}
	rg, _ := h.bs.GetBoardSettings(ctx, "team")
	assert.False(t, rg.RequireGoal)
	code, out := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","require_goal":true}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 200, code, "%v", out)
	rg, _ = h.bs.GetBoardSettings(ctx, "team")
	assert.True(t, rg.RequireGoal)
	actions, _ = h.bs.RecentHubOperatorActions(ctx, 5)
	require.NotEmpty(t, actions)
	assert.Equal(t, ownerLabel, actions[0].HubUser)
	// This computer is as before.
	code, _ = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true}`, nil)
	assert.Equal(t, 200, code)
}

func TestTheLocalLockAndTheRateLimitHoldForTheOwnersSettingsRoute(t *testing.T) {
	h, _ := hubSettingsEnv(t, false)                                                                             // "Let Coral Hub change cross-team settings" is off
	code, _ := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":false}`, nil) // this computer: it starts off
	require.Equal(t, 200, code)
	code, out := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 403, code)
	assert.Equal(t, "hub_changes_off", out["code"])
	set, _ := h.bs.GetBoardSettings(context.Background(), "team")
	assert.False(t, set.CrossTeamMessaging)
	// an unreadable lock refuses too
	h.hubCrossTeamLock = func(context.Context) (bool, error) { return true, errors.New("settings unreadable") }
	code, out = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 403, code)
	assert.Equal(t, "hub_changes_off", out["code"])

	// On, the limit of the switch routes applies to this route too: hubSwitchPerMinute a minute for the team.
	h.hubCrossTeamLock = func(context.Context) (bool, error) { return true, nil }
	for i := 0; i < hubSwitchPerMinute; i++ {
		code, _ = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true}`, ownerHeaders(ownerLabel))
		require.Equal(t, 200, code, "request %d", i)
	}
	code, out = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":false}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 429, code)
	assert.Equal(t, "hub_switch_rate_limited", out["code"])
	set, _ = h.bs.GetBoardSettings(context.Background(), "team")
	assert.True(t, set.CrossTeamMessaging, "a limited request changes nothing")
	// A request that touches no cross-team setting (the health setup) does not use the limit.
	code, _ = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator"}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 200, code)
}

// The change and its record are one or neither: when the record cannot be written the change is undone and the owner is told (the switch routes' rule, #5572 condition 4).
func TestAHubSettingsChangeThatCannotBeRecordedIsUndone(t *testing.T) {
	dbPath := t.TempDir() + "/board_test.db"
	bs, err := boardtest.Open(dbPath)
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	withLabel(t, ownerLabel, nil)
	h.hubCrossTeamLock = func(context.Context) (bool, error) { return true, nil }
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "team", "Dev", "Developer", "dev-session", nil, "all")
	require.NoError(t, err)
	code, _ := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":false,"cross_team_artifacts":false}`, nil)
	require.Equal(t, 200, code)

	// A second connection puts a trigger in the way of the Operator-actions row.
	raw, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	t.Cleanup(func() { raw.Close() })
	_, err = raw.Exec(`CREATE TRIGGER no_hub_actions BEFORE INSERT ON hub_operator_actions BEGIN SELECT RAISE(ABORT, 'cannot record'); END`)
	require.NoError(t, err)

	code, out := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true,"cross_team_artifacts":true,"cross_team_servers":["srv_abc"],"require_goal":true}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 500, code)
	assert.Equal(t, "record_failed", out["code"])
	set, err := bs.GetBoardSettings(ctx, "team")
	require.NoError(t, err)
	assert.False(t, set.CrossTeamMessaging, "the change is undone")
	assert.False(t, set.CrossTeamArtifacts)
	assert.Empty(t, set.CrossTeamServers)
	assert.False(t, set.RequireGoal, "require_goal is undone with the rest")
	msgs, _ := bs.ListMessages(ctx, "team", 50, 0, 0)
	for _, m := range msgs {
		assert.False(t, m.Origin != nil && *m.Origin == board.OriginHubNotice, "no notice for a change that was not made")
	}

	// With the record writable again the same request is made and recorded.
	_, err = raw.Exec(`DROP TRIGGER no_hub_actions`)
	require.NoError(t, err)
	code, _ = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 200, code)
}
