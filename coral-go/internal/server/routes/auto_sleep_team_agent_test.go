package routes

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// What a real team does (#12335's v2.0.34 finding: three agents, 23 idle minutes at 15, none slept): an agent that fired no event is idle from its creation (launched_at is NULL for a launch,
// and means created_at), and a team agent parked in `coral-board wait` ("Waiting for a message") is idle: the message it waits for is a delivery, which wakes it.

// newQuietSleepRig is newSleepRig for an agent that has not fired one event.
func newQuietSleepRig(t *testing.T) *sleepRig {
	t.Helper()
	_, h, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "autosleep"
	sid := uuid.NewString()
	name := naming.SessionName("claude", sid)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "dev", AgentType: "claude", BoardName: &team, WorkingDir: "/tmp"}))
	_, err := h.bs.Subscribe(ctx, team, "dev", "Developer", name, nil, "all")
	require.NoError(t, err)
	mock.addSession(name, "/tmp")
	term := &autoSleepTerm{mockSessionTerminal: mock, screen: emptyBoxScreen}
	h.terminal = term
	return &sleepRig{h: h, term: term, ss: ss, sid: sid, name: name, ctx: ctx}
}

func TestAnAgentThatFiredNoEventIsIdleFromItsCreation(t *testing.T) {
	r := newQuietSleepRig(t)
	ls := r.pass(t)
	assert.Equal(t, 1, ls.IsSleeping, "no event and no launched_at: idle since created_at, two hours on: asleep")
}

func TestAnAgentParkedInABoardWaitIsIdle(t *testing.T) {
	for _, kind := range []string{"message", "task", "any", "commit"} {
		t.Run(kind, func(t *testing.T) {
			r := newSleepRig(t)
			_, err := r.h.bs.RegisterWait(r.ctx, "autosleep", "dev", r.name, kind, "", "waiting for a message", 10*time.Hour)
			require.NoError(t, err)
			ls := r.pass(t)
			assert.Equal(t, 1, ls.IsSleeping, "a %s wait ends with a typed nudge, which wakes it", kind)
		})
	}
}

// The real shape of a parked team agent: its last event is a tool (the wait is a command that has not returned), so it reads as mid-turn.
func TestAnAgentInsideABoardWaitIsIdleAndOneInsideAnyOtherToolIsNot(t *testing.T) {
	parked := func(t *testing.T, wait bool) int {
		r := newQuietSleepRig(t)
		_, err := r.h.ts.InsertAgentEvent(r.ctx, &store.AgentEvent{AgentName: "dev", SessionID: &r.sid, EventType: "tool_use"})
		require.NoError(t, err)
		if wait {
			_, err = r.h.bs.RegisterWait(r.ctx, "autosleep", "dev", r.name, "message", "", "waiting for a message", 10*time.Hour)
			require.NoError(t, err)
		}
		return r.pass(t).IsSleeping
	}
	assert.Equal(t, 1, parked(t, true), "a tool call open for two hours inside a registered wait: parked, asleep")
	assert.Equal(t, 0, parked(t, false), "a tool call open for two hours and no wait: a turn going on (a long build), awake")
}

// An agent that interrupted its wait and went on to a long command keeps the registration but has a later event: still in its turn (Security, #12335).
func TestAnAgentThatMovedOnFromItsWaitIsStillInItsTurn(t *testing.T) {
	r := newQuietSleepRig(t)
	_, err := r.h.bs.RegisterWait(r.ctx, "autosleep", "dev", r.name, "message", "", "waiting for a message", 10*time.Hour)
	require.NoError(t, err)
	_, err = r.h.ts.InsertAgentEvent(r.ctx, &store.AgentEvent{AgentName: "dev", SessionID: &r.sid, EventType: "tool_use", CreatedAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)})
	require.NoError(t, err)
	assert.Equal(t, 0, r.pass(t).IsSleeping, "a tool call a minute after the wait was registered is not the wait: awake")
}
