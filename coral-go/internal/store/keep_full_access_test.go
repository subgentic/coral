package store_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// The Operator's "Keep Full access when this agent restarts" choice for a Codex agent (#14061), kept per session in a small table of its own (as the auto-sleep opt-out is): a restart, a resume or a wake
// replaces nothing of it, a replaced session (a restart gives the agent a new id) carries it to the new one, and an edit of the agent's capabilities clears it.
func TestKeepFullAccessIsPerSessionAndCleared(t *testing.T) {
	ss := autoSleepStore(t)
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "k1", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp"}))
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "k2", AgentType: "codex", AgentName: "b", WorkingDir: "/tmp"}))
	on, err := ss.KeepFullAccess(ctx, "k1")
	require.NoError(t, err)
	assert.False(t, on, "off until the Operator turns it on")

	changed, err := ss.SetKeepFullAccess(ctx, "k1", true)
	require.NoError(t, err)
	assert.True(t, changed)
	changed, err = ss.SetKeepFullAccess(ctx, "k1", true)
	require.NoError(t, err)
	assert.False(t, changed, "turning it on again changes nothing, so it is not logged as a change")
	on, _ = ss.KeepFullAccess(ctx, "k1")
	assert.True(t, on)
	other, _ := ss.KeepFullAccess(ctx, "k2")
	assert.False(t, other, "one agent's choice is not another's")
	set, err := ss.KeepFullAccessSessions(ctx)
	require.NoError(t, err)
	assert.Equal(t, map[string]bool{"k1": true}, set)

	// a row registered again (a restart of the same record) does not lose it
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "k1", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp"}))
	on, _ = ss.KeepFullAccess(ctx, "k1")
	assert.True(t, on)

	changed, err = ss.SetKeepFullAccess(ctx, "k1", false)
	require.NoError(t, err)
	assert.True(t, changed)
	on, _ = ss.KeepFullAccess(ctx, "k1")
	assert.False(t, on)
}

func TestAReplacedSessionKeepsItsFullAccessChoiceUnlessTheCapabilitiesChange(t *testing.T) {
	ss := autoSleepStore(t)
	ctx := context.Background()
	narrow := `{"allow":["file_read"]}`
	wider := `{"allow":["file_read","file_write"]}`
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "r1", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp", Capabilities: &narrow}))
	_, err := ss.SetKeepFullAccess(ctx, "r1", true)
	require.NoError(t, err)

	// a restart with the same capabilities (or none given: they are carried): the choice follows the agent to its new session
	require.NoError(t, ss.ReplaceLiveSession(ctx, "r1", &store.LiveSession{SessionID: "r2", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp"}))
	on, _ := ss.KeepFullAccess(ctx, "r2")
	assert.True(t, on, "carried to the new session")
	old, _ := ss.KeepFullAccess(ctx, "r1")
	assert.False(t, old, "and gone from the old one")

	// a restart that EDITS the capabilities clears it: the person narrowed or changed what the agent may do on purpose
	require.NoError(t, ss.ReplaceLiveSession(ctx, "r2", &store.LiveSession{SessionID: "r3", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp", Capabilities: &wider}))
	on, _ = ss.KeepFullAccess(ctx, "r3")
	assert.False(t, on, "a capabilities edit clears it")

	// the same capabilities spelled again are not an edit
	_, err = ss.SetKeepFullAccess(ctx, "r3", true)
	require.NoError(t, err)
	require.NoError(t, ss.ReplaceLiveSession(ctx, "r3", &store.LiveSession{SessionID: "r4", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp", Capabilities: &wider}))
	on, _ = ss.KeepFullAccess(ctx, "r4")
	assert.True(t, on, "unchanged capabilities keep it")
}

// A choice the hub made ends with the hub's switch; one made locally does not, and a local on over a hub one makes it local (#14193).
func TestAHubMadeChoiceEndsWithTheHubsSwitchAndALocalOneDoesNot(t *testing.T) {
	s := autoSleepStore(t)
	ctx := context.Background()
	for _, id := range []string{"hub-1", "local-1", "both-1"} {
		require.NoError(t, s.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "codex", AgentName: id, WorkingDir: "/tmp"}))
	}
	_, err := s.SetKeepFullAccessFrom(ctx, "hub-1", true, store.KeepSourceHub)
	require.NoError(t, err)
	_, err = s.SetKeepFullAccess(ctx, "local-1", true)
	require.NoError(t, err)
	_, err = s.SetKeepFullAccessFrom(ctx, "both-1", true, store.KeepSourceHub)
	require.NoError(t, err)
	changed, err := s.SetKeepFullAccess(ctx, "both-1", true) // the Operator then chooses it locally too
	require.NoError(t, err)
	require.False(t, changed, "already on: not a new choice")

	n, err := s.ClearHubKeepFullAccess(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, n, "only the hub-made one ended")
	for id, want := range map[string]bool{"hub-1": false, "local-1": true, "both-1": true} {
		on, err := s.KeepFullAccess(ctx, id)
		require.NoError(t, err)
		require.Equal(t, want, on, id)
	}
}

// The source goes with the choice to the replacing session.
func TestTheSourceOfAChoiceIsCarriedToTheReplacingSession(t *testing.T) {
	s := autoSleepStore(t)
	ctx := context.Background()
	caps := `{"allow":["file_read"]}`
	require.NoError(t, s.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "old-hub", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp", Capabilities: &caps}))
	_, err := s.SetKeepFullAccessFrom(ctx, "old-hub", true, store.KeepSourceHub)
	require.NoError(t, err)
	require.NoError(t, s.ReplaceLiveSession(ctx, "old-hub", &store.LiveSession{SessionID: "new-hub", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp", Capabilities: &caps}))
	n, err := s.ClearHubKeepFullAccess(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, n, "the replacing session's choice is still the hub's")
}
