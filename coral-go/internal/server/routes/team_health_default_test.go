package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/pkg/tunnel"
)

func healthTestStore(t *testing.T) *board.Store {
	t.Helper()
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = bs.Close() })
	return bs
}

// #4962: the live list tells each team row whether its team's health check is on (the icon beside the team's info button reads it): a
// team that never stored a setting is off (the new default), one that has it on is on, and a request through Coral Hub gets no field.
func TestLiveRowsCarryTheTeamsHealthCheckState(t *testing.T) {
	bs := healthTestStore(t)
	ctx := context.Background()
	require.NoError(t, bs.SetHealthOn(ctx, "checked", true))
	require.NoError(t, bs.SetHealthOn(ctx, "unchecked", false))
	h := &SessionsHandler{bs: bs}
	rows := func() []map[string]any {
		return []map[string]any{{"board_project": "checked"}, {"board_project": "unchecked"}, {"board_project": "fresh"}, {"board_project": nil}, {}}
	}

	local := rows()
	h.addTeamHealth(httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil), local)
	assert.Equal(t, true, local[0]["team_health_on"])
	assert.Equal(t, false, local[1]["team_health_on"])
	assert.Equal(t, false, local[2]["team_health_on"], "a team with nothing stored is off: only a team made by a launch is stored on (#10683)")
	assert.NotContains(t, local[3], "team_health_on", "an agent on no team has no field")
	assert.NotContains(t, local[4], "team_health_on")

	via := httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil)
	via.Header.Set(tunnel.ViaHeader, "1")
	tunneled := rows()
	h.addTeamHealth(via, tunneled)
	for _, row := range tunneled {
		assert.NotContains(t, row, "team_health_on", "the check's settings are the local dashboard's: Coral Hub gets none")
	}
}

// #10683, the operator: a team this launch makes has its check on unless the request says off; a team that already exists keeps what it has (one that never stored a setting stays off), and a
// relaunch never turns off a check the operator turned on, nor turns on one the operator turned off.
func TestLaunchTeamHealthOption(t *testing.T) {
	bs := healthTestStore(t)
	ctx := context.Background()
	cfg := &config.Config{}
	cfg.UseCoralDir(t.TempDir())
	h := &SessionsHandler{bs: bs, cfg: cfg}
	yes, no := true, false

	h.restoreTeamTemplate(ctx, &launchTeamRequest{BoardName: "new-default", newTeam: true})
	assert.True(t, bs.GetHealthSettings(ctx, "new-default").On, "a team made by the launch has the check on")
	assert.True(t, bs.HasHealthSettings(ctx, "new-default"), "and it is stored, not just a default")
	h.restoreTeamTemplate(ctx, &launchTeamRequest{BoardName: "new-false", newTeam: true, HealthMonitor: &no})
	assert.False(t, bs.GetHealthSettings(ctx, "new-false").On, "the New project switch turned off: off")
	assert.True(t, bs.HasHealthSettings(ctx, "new-false"), "and that choice is stored")
	h.restoreTeamTemplate(ctx, &launchTeamRequest{BoardName: "new-on", newTeam: true, HealthMonitor: &yes})
	assert.True(t, bs.GetHealthSettings(ctx, "new-on").On, "the option turns it on")

	h.restoreTeamTemplate(ctx, &launchTeamRequest{BoardName: "old-never-stored"})
	assert.False(t, bs.GetHealthSettings(ctx, "old-never-stored").On, "a team that exists and never stored a setting stays off")
	assert.False(t, bs.HasHealthSettings(ctx, "old-never-stored"))

	require.NoError(t, bs.SetHealthOn(ctx, "kept", true))
	h.restoreTeamTemplate(ctx, &launchTeamRequest{BoardName: "kept", HealthMonitor: &no})
	assert.True(t, bs.GetHealthSettings(ctx, "kept").On, "a relaunch never turns off a check the operator turned on")
	require.NoError(t, bs.SetHealthOn(ctx, "kept-off", false))
	h.restoreTeamTemplate(ctx, &launchTeamRequest{BoardName: "kept-off", newTeam: true})
	assert.False(t, bs.GetHealthSettings(ctx, "kept-off").On, "nor turns on one the operator turned off")
}

// #5119: the icon blinked. A read of the health settings that fails for a tick (a busy database, a request that ended) used to read as every
// team off, so a team with the check on was reported off for that tick and on again after it. The last state read stands.
func TestTeamHealthStateDoesNotFlipWhenTheReadFails(t *testing.T) {
	bs := healthTestStore(t)
	require.NoError(t, bs.SetHealthOn(context.Background(), "checked", true))
	h := &SessionsHandler{bs: bs}
	rows := func() []map[string]any { return []map[string]any{{"board_project": "checked"}} }

	ok := rows()
	h.addTeamHealth(httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil), ok)
	require.Equal(t, true, ok[0]["team_health_on"])

	ended, cancel := context.WithCancel(context.Background())
	cancel() // a read with this context fails
	for i := 0; i < 5; i++ {
		failed := rows()
		h.addTeamHealth(httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil).WithContext(ended), failed)
		assert.Equal(t, true, failed[0]["team_health_on"], "the check stays on when a tick cannot read the settings")
	}

	fresh := &SessionsHandler{bs: bs} // nothing read yet: no state to stand on, so no field (the dashboard keeps what it has)
	none := rows()
	fresh.addTeamHealth(httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil).WithContext(ended), none)
	assert.NotContains(t, none[0], "team_health_on")

	require.NoError(t, bs.SetHealthOn(context.Background(), "checked", false)) // a real change still comes through
	off := rows()
	h.addTeamHealth(httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil), off)
	assert.Equal(t, false, off[0]["team_health_on"])
}
