package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The operator's decision (2026-10-27, #9034; coral-hub's finding): the Hub is the source of truth and its owner is an authenticated user on their own hardware, so a Hub owner changes the team's health setup
// exactly as the owner here does: no extra lock, no extra rate limit, and no record or notice that a local change does not get either.
func TestAHubOwnersHealthChangeAppliesAsTheLocalOwnersDoes(t *testing.T) {
	h, _ := hubSettingsEnv(t, false) // "Let Coral Hub change cross-team settings" is off: it governs the cross-team settings, not health
	ctx := context.Background()
	body := func(i string) string {
		return `{"subscriber_id":"Operator","health":{"on":true,"interval_min":` + i + `,"recipient":"Dev","goals_ready":{"on":true,"wait_min":30},"unowned_tasks":{"on":false,"wait_min":15}}}`
	}
	// More requests than the cross-team limit allows a minute: none is limited.
	for i := 0; i < hubSwitchPerMinute+3; i++ {
		code, out := boardCall(t, h, http.MethodPut, body([]string{"5", "10"}[i%2]), ownerHeaders(ownerLabel))
		require.Equal(t, 200, code, "request %d: %v", i, out)
	}
	code, out := boardCall(t, h, http.MethodPut, body("10"), ownerHeaders(ownerLabel))
	require.Equal(t, 200, code, "%v", out)
	set, err := h.bs.GetBoardSettings(ctx, "team")
	require.NoError(t, err)
	assert.True(t, set.Health.On)
	assert.Equal(t, "Dev", set.Health.Recipient)
	assert.True(t, set.Health.GoalsReady.On)
	assert.False(t, set.Health.UnownedTasks.On)
	assert.Equal(t, 10, set.Health.IntervalMin)

	// As on this computer: no hub notice and no Operator-actions row for a health change.
	assert.Zero(t, hubNotices(t, h))
	actions, err := h.bs.RecentHubOperatorActions(ctx, 5)
	require.NoError(t, err)
	assert.Empty(t, actions)
	// A grantee still cannot (the owner route, #5307).
	code, out = boardCall(t, h, http.MethodPut, body("5"), granteeHeaders())
	assert.Equal(t, 403, code)
	assert.Equal(t, "owner_only", out["code"])
}
