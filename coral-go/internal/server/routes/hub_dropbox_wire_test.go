package routes

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// A team's computer, or one whose enrolment record cannot be read, never shares through the Hub in v1 (#16109, coral-hub's Security on #211076): the switch reads as off
// whatever it is set to, so every route answers disabled before prepare.
func TestNewHubDropbox_ATeamComputerIsRefusedWhateverTheSwitchSays(t *testing.T) {
	e := newDropboxEnv(t)
	require.NoError(t, e.h.ss.SetSetting(t.Context(), HubDropboxShareSetting, "true"))
	d := e.h.NewHubDropbox(t.TempDir(), nil)
	t.Cleanup(func() { SetHubOwnerRecord(nil) })

	SetHubOwnerRecord(func(context.Context) (string, string, error) { return tunnel.OwnerKindPersonal, "", nil })
	on, err := d.On(t.Context())
	require.NoError(t, err)
	assert.True(t, on, "a personal computer with the switch on shares")

	SetHubOwnerRecord(func(context.Context) (string, string, error) { return tunnel.OwnerKindTeam, "acme", nil })
	on, _ = d.On(t.Context())
	assert.False(t, on, "a team's computer is refused")

	SetHubOwnerRecord(func(context.Context) (string, string, error) { return "", "", errors.New("unreadable") })
	on, _ = d.On(t.Context())
	assert.False(t, on, "an unreadable record counts as a team's")
}
