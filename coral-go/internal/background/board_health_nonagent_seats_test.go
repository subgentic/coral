package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21705: the check counts agents that work on this computer. A Hub user (a member of another server) and a seat with no session at all are people or leftovers, not agents: not named, not counted offline.
func TestARemoteMemberAndASeatWithNoSessionAreNotCountedAsAgents(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Agent", "Developer", 2, 30*time.Minute) // idle, with no work
	hub := "hub.example"
	_, err := h.s.Subscribe(ctx, "team", "Hub Person", "Member", "claude-00000009-0000-0000-0000-000000000000", &hub, "all")
	require.NoError(t, err)
	_, err = h.s.Subscribe(ctx, "team", "Persona", "Tester", "", nil, "all")
	require.NoError(t, err)
	out := h.check()
	assert.Contains(t, out, "1 idle")
	assert.NotContains(t, out, "Hub Person")
	assert.NotContains(t, out, "Persona")
	assert.NotContains(t, out, "offline", "neither is an offline agent: "+out)
}
