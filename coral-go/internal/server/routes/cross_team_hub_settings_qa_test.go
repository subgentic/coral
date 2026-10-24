package routes

import (
	"context"
	"database/sql"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
)

// QA probes for #7329: edges of the owner's settings route through Coral Hub.

func TestQAHubSettingsOwnerSetsMessagingAndRequireGoalTogether(t *testing.T) {
	h, _ := hubSettingsEnv(t, true)
	code, _ := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":false}`, nil)
	require.Equal(t, 200, code)
	code, out := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true,"require_goal":true}`, ownerHeaders(ownerLabel))
	require.Equal(t, 200, code, "%v", out)
	set, _ := h.bs.GetBoardSettings(context.Background(), "team")
	assert.True(t, set.CrossTeamMessaging)
	assert.True(t, set.RequireGoal)
}

func TestQAHubSettingsRefusedRequestsLeaveNoRecord(t *testing.T) {
	h, _ := hubSettingsEnv(t, true)
	ctx := context.Background()
	for _, body := range []string{
		`{"subscriber_id":"Operator","cross_team_allowed":[{"server":"local","cross_team_id":"a name"}]}`,
		`{"subscriber_id":"Operator","cross_team_servers":["not a server id"]}`,
	} {
		code, _ := boardCall(t, h, http.MethodPut, body, ownerHeaders(ownerLabel))
		assert.Equal(t, 400, code, body)
	}
	last, _ := h.bs.LastSwitchChanges(ctx, "team")
	assert.Empty(t, last)
	log, _ := h.bs.ListLog(ctx, "team")
	for _, e := range log {
		assert.NotEqual(t, board.LogEdit, e.Kind, "a refused edit is no edit: %+v", e)
	}
	msgs, _ := h.bs.ListMessages(ctx, "team", 50, 0, 0)
	for _, m := range msgs {
		assert.False(t, m.Origin != nil && *m.Origin == board.OriginHubNotice, "no notice for a refused request")
	}
}

func TestQAHubSettingsNoChangeRequestPostsNoNotice(t *testing.T) {
	h, _ := hubSettingsEnv(t, true)
	ctx := context.Background()
	code, _ := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true,"cross_team_artifacts":false}`, ownerHeaders(ownerLabel))
	require.Equal(t, 200, code)
	n0 := hubNotices(t, h)
	for i := 0; i < 3; i++ {
		code, _ = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true,"cross_team_artifacts":false,"cross_team_servers":[],"cross_team_allowed":[]}`, ownerHeaders(ownerLabel))
		require.Equal(t, 200, code)
	}
	assert.Equal(t, n0, hubNotices(t, h), "same values: no notice")
	_ = ctx
}

func hubNotices(t *testing.T, h *BoardHandler) int {
	msgs, err := h.bs.ListMessages(context.Background(), "team", 200, 0, 0)
	require.NoError(t, err)
	n := 0
	for _, m := range msgs {
		if m.Origin != nil && *m.Origin == board.OriginHubNotice {
			n++
		}
	}
	return n
}

// A failed record of one part (the settings log) undoes ALL four fields, including the list.
func TestQAHubSettingsLogFailureUndoesTheListAndTheServers(t *testing.T) {
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
	before, _ := bs.GetBoardSettings(ctx, "team")

	raw, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	t.Cleanup(func() { raw.Close() })
	_, err = raw.Exec(`CREATE TRIGGER no_edit_log BEFORE INSERT ON board_settings_log BEGIN SELECT RAISE(ABORT, 'cannot record'); END`)
	require.NoError(t, err)

	body := `{"subscriber_id":"Operator","cross_team_messaging":true,"cross_team_artifacts":true,"cross_team_servers":["srv_abc"],"cross_team_allowed":[{"server":"local","cross_team_id":"x-` + "qqqqqqqqqqqqqqqq" + `"}]}`
	code, out := boardCall(t, h, http.MethodPut, body, ownerHeaders(ownerLabel))
	assert.Equal(t, 500, code, "%v", out)
	after, _ := bs.GetBoardSettings(ctx, "team")
	assert.Equal(t, before.CrossTeamMessaging, after.CrossTeamMessaging)
	assert.Equal(t, before.CrossTeamArtifacts, after.CrossTeamArtifacts)
	assert.Empty(t, after.CrossTeamServers)
	assert.Empty(t, after.CrossTeamAllowed, "the list is undone too")
	acts, _ := bs.RecentHubOperatorActions(ctx, 5)
	assert.Empty(t, acts, "one transaction: no Operator-actions row either")
	last, _ := bs.LastSwitchChanges(ctx, "team")
	for k, c := range last {
		assert.NotEqual(t, board.SwitchViaHub, c.Via, "one transaction: no via-hub switch row either: %s", k)
	}
}

// Health travels in the same body: when the record fails, is it undone too?
func TestQAHubSettingsRecordFailureAlsoUndoesHealthInTheSameBody(t *testing.T) {
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
	code, _ := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":false}`, nil)
	require.Equal(t, 200, code)
	before, _ := bs.GetBoardSettings(ctx, "team")
	raw, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	t.Cleanup(func() { raw.Close() })
	_, err = raw.Exec(`CREATE TRIGGER no_hub_actions BEFORE INSERT ON hub_operator_actions BEGIN SELECT RAISE(ABORT, 'cannot record'); END`)
	require.NoError(t, err)
	code, _ = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true,"health":{"on":true}}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 500, code)
	after, _ := bs.GetBoardSettings(ctx, "team")
	assert.Equal(t, before.Health, after.Health, "the whole body is one change or none")
}
