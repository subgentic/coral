package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// #19543 (the Operator): coral-hub's agents ran in Auto (set with Shift+Tab, saved mode Default), were put to sleep and woken with --permission-mode default, and asked for every permission. A Claude agent is
// woken (and restarted) in the mode its hooks last reported, recorded on the row so the wake after it keeps it too; never above what the Operator chose.
func TestAWokenClaudeAgentKeepsTheModeItWasLastIn(t *testing.T) {
	cases := []struct {
		name, stored, live string
		flags              []string
		want               string
	}{
		{"saved Default, in Auto: wakes in Auto", "default", "auto", nil, "auto"},
		{"saved Default, in Plan: wakes in Plan", "default", "plan", nil, "plan"},
		{"saved Auto, back in Default: wakes in Default", "auto", "default", nil, "default"},
		{"saved Bypass, in Auto: wakes in Auto (less, allowed)", "bypassPermissions", "auto", nil, "auto"},
		{"saved Bypass, still Bypass", "bypassPermissions", "bypassPermissions", nil, "bypassPermissions"},
		{"saved Default, in Bypass: never raised", "default", "bypassPermissions", nil, "default"},
		{"saved Auto, in Bypass: never raised", "auto", "bypassPermissions", nil, "auto"},
		{"saved Default but started with the skip flag, in Bypass: the launch allowed it", "default", "bypassPermissions", []string{"--allow-dangerously-skip-permissions"}, "bypassPermissions"},
		{"no live mode reported: the saved one", "auto", "", nil, "auto"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			rig := claudeRig(t)
			ctx := context.Background()
			sid := "bbbbbbbb-4444-5555-6666-000000000019"
			require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Claude, AgentName: "Frontend Dev", WorkingDir: rig.workdir,
				Flags: store.MarshalFlags(c.flags), PermissionMode: ptr.NonEmpty(c.stored)}))
			rig.h.noteLiveMode(sid, at.Claude, c.live)
			check := func(step, cmd string) {
				t.Helper()
				m := modeOf(cmd)
				require.NotEmpty(t, m, "%s: %s", step, cmd)
				assert.Equal(t, c.want, m[len(m)-1], "%s: %s", step, cmd)
			}
			check("wake", rig.wake(t, sid))
			ls, err := rig.ss.GetLiveSession(ctx, sid)
			require.NoError(t, err)
			require.NotNil(t, ls.PermissionMode)
			assert.Equal(t, c.want, *ls.PermissionMode, "the mode it woke in is the row's")
			// a second sleep and wake, the server's memory gone (a restart of Coral): the recorded mode is kept
			rig.h.liveModes.Delete(sid)
			check("second wake", rig.wake(t, sid))
			// a restart of the same agent starts it in the mode it was in
			rig.h.noteLiveMode(sid, at.Claude, c.live)
			sname := naming.SessionName(at.Claude, sid)
			require.NoError(t, rig.term.CreateSession(ctx, sname, rig.workdir))
			rig.post(t, "/api/sessions/live/"+sname+"/restart", map[string]any{"session_id": sid, "agent_type": at.Claude})
			check("restart", lastSentCommand(rig.term))
		})
	}
}
