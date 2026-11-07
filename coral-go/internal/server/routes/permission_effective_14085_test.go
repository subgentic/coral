package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

// "An agent launched with bypass silently runs narrower" (#14085): a role's capabilities narrow the chosen mode for Codex and agy, and the row now says what the launch really gives, next to
// what was chosen, with the same stored Operator choice (#14061) lifting it. A Claude row has the choice too but never a narrowing: its capabilities add rules and do not lower a mode.
func TestARowSaysWhatTheLaunchReallyGivesNextToTheModeChosen(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	writer := `{"allow":["file_read","file_write","shell:coral-board *"]}`
	skip, codexBypass, bypass := `["--dangerously-skip-permissions"]`, `["--dangerously-bypass-approvals-and-sandbox"]`, "bypassPermissions"
	add := func(sid, name, agentType string, flags, caps, mode *string) {
		t.Helper()
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: agentType, WorkingDir: "/tmp/project", Flags: flags, Capabilities: caps, PermissionMode: mode}))
		require.NoError(t, ss.SetSessionSleepingFor(ctx, sid, store.SleepReasonIdle))
	}
	agy, cx, cl := sid(81), sid(82), sid(83)
	add(agy, "Technical Writer", "agy", &skip, &writer, &bypass)
	add(cx, "Codex Writer", "codex", &codexBypass, &writer, &bypass)
	add(cl, "Claude Writer", "claude", &skip, &writer, &bypass)
	_ = h

	pe := func(id string) any { return listedRow(t, server, id)[permissionEffectiveField] }
	narrowed := func(want string) map[string]any {
		return map[string]any{"chosen": "Bypass permissions", "effective": want, "narrowed": true, "why": whyNarrowed}
	}
	require.Equal(t, narrowed("Accept edits"), pe(agy), "the Operator's report: Bypass chosen, accept-edits run")
	cxRow := listedRow(t, server, cx)[permissionEffectiveField].(map[string]any)
	require.Equal(t, true, cxRow["narrowed"])
	require.Equal(t, "Full access", cxRow["chosen"])
	require.Nil(t, pe(cl), "Claude's capabilities never lower a chosen mode")
	for _, id := range []string{agy, cx, cl} {
		require.Equal(t, false, listedRow(t, server, id)[keepFullAccessField], "the key is a boolean for all three agents")
	}

	// the Operator's choice lifts it, for each
	for _, id := range []string{agy, cx, cl} {
		_, err := ss.SetKeepFullAccess(ctx, id, true)
		require.NoError(t, err)
	}
	require.Equal(t, map[string]any{"chosen": "Bypass permissions", "effective": "Bypass permissions", "narrowed": false}, pe(agy))
	require.Nil(t, pe(cx), "Full access either way: no narrowing to say")
	require.Equal(t, true, listedRow(t, server, agy)[keepFullAccessField])
	require.Equal(t, true, listedRow(t, server, cl)[keepFullAccessField])
}

// An agy agent with no capabilities says what it was started with and nothing is narrowed; the key is there for it always, and null for a Claude or Codex row with nothing to say.
func TestAnAgyRowAlwaysSaysWhatItWasStartedWith(t *testing.T) {
	server, _, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	plan := "plan"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid(84), AgentName: "Planner", AgentType: "agy", WorkingDir: "/tmp/project", PermissionMode: &plan}))
	require.NoError(t, ss.SetSessionSleepingFor(ctx, sid(84), store.SleepReasonIdle))
	require.Equal(t, map[string]any{"chosen": "Plan (read-only)", "effective": "Plan (read-only)", "narrowed": false}, listedRow(t, server, sid(84))[permissionEffectiveField])
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid(85), AgentName: "Plain Claude", AgentType: "claude", WorkingDir: "/tmp/project"}))
	require.NoError(t, ss.SetSessionSleepingFor(ctx, sid(85), store.SleepReasonIdle))
	row := listedRow(t, server, sid(85))
	require.Contains(t, row, permissionEffectiveField)
	require.Nil(t, row[permissionEffectiveField])
}
