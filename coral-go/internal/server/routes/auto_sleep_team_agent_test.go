package routes

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
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

// An unreadable store is never "parked": the kill that follows cannot be undone, so a wait that cannot be read keeps the agent awake (QA, #12335). GetActiveWait answers (nil, nil) for a read that
// failed, and the rule must treat that as no wait, in the pass as well as on its own.
func TestAnUnreadableWaitStoreLeavesTheAgentAwake(t *testing.T) {
	r := newQuietSleepRig(t)
	_, err := r.h.bs.RegisterWait(r.ctx, "autosleep", "dev", r.name, "message", "", "waiting for a message", 10*time.Hour)
	require.NoError(t, err)
	_, err = r.h.ts.InsertAgentEvent(r.ctx, &store.AgentEvent{AgentName: "dev", SessionID: &r.sid, EventType: "tool_use"})
	require.NoError(t, err)
	assert.True(t, r.h.parkedInWait(r.ctx, "autosleep", "dev", time.Now()), "readable: parked")
	require.NoError(t, r.h.bs.Close())
	assert.False(t, r.h.parkedInWait(r.ctx, "autosleep", "dev", time.Now()), "unreadable: not parked")
	assert.Equal(t, 0, r.pass(t).IsSleeping, "and the pass leaves the agent awake")
}

// The reason an agent stays awake is in the log when it changes, at Info (#12335: it was Debug, so a real install's log said nothing about why no agent slept).
func TestAutoSleepLogsTheReasonOnceWhenItChanges(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })
	r := newSleepRig(t)
	at := time.Now()
	r.h.autoSleepPass(r.ctx, at)
	r.h.autoSleepPass(r.ctx, at.Add(time.Minute))
	assert.Equal(t, 1, strings.Count(buf.String(), "auto_sleep verdict"), "not_idle_long_enough twice: logged once: "+buf.String())
	assert.Contains(t, buf.String(), "reason=not_idle_long_enough")
	buf.Reset()
	r.h.autoSleepPass(r.ctx, at.Add(2*time.Hour))
	r.h.autoSleepPass(r.ctx, at.Add(2*time.Hour+time.Minute))
	assert.Contains(t, buf.String(), "reason=process_busy", "the reason changed: logged again")
}

// A parked real worker's screen names its `coral-board wait` as one background shell (Beta Tester, v2.0.34: background_running for 36 minutes): with its wait registered it sleeps; with no wait, or with a second
// shell, it does not (#12335).
func TestAWorkerWhoseOnlyBackgroundShellIsItsWaitSleeps(t *testing.T) {
	const oneShell = "✻ Cogitated for 4s · done 5:38 PM · 1 shell still running\n\n──────────────────────────────────────────────────────────────────────\n❯ \n──────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage\n"
	for name, tc := range map[string]struct {
		wait   bool
		screen string
		asleep int
	}{
		"the wait is the one shell": {true, oneShell, 1},
		"one shell and no wait":     {false, oneShell, 0},
		"a second shell besides it": {true, strings.ReplaceAll(oneShell, "1 shell", "2 shells"), 0},
	} {
		t.Run(name, func(t *testing.T) {
			r := newSleepRig(t)
			r.term.screen = tc.screen
			if tc.wait {
				_, err := r.h.bs.RegisterWait(r.ctx, "autosleep", "dev", r.name, "message", "", "waiting for a message", 10*time.Hour)
				require.NoError(t, err)
			}
			assert.Equal(t, tc.asleep, r.pass(t).IsSleeping, name)
		})
	}
}

// Security (#12335): the wait is the one shell only while nothing ran after it. A tool a minute after the wait was registered is a job the agent started (a dev server): it keeps its shell; the turn's own
// end after the wait does not.
func TestAWaitIsTheOneShellOnlyWhileNothingRanAfterIt(t *testing.T) {
	const oneShell = "✻ Cogitated for 4s · done 5:38 PM · 1 shell still running\n\n──────────────────────────────────────────────────────────────────────\n❯ \n──────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage\n"
	for name, tc := range map[string]struct {
		later  string
		asleep int
	}{
		"the turn ends after the wait": {"stop", 1},
		"a tool runs after the wait":   {"tool_use", 0},
		"a new prompt after the wait":  {"prompt_submit", 0},
	} {
		t.Run(name, func(t *testing.T) {
			r := newSleepRig(t)
			r.term.screen = oneShell
			_, err := r.h.bs.RegisterWait(r.ctx, "autosleep", "dev", r.name, "message", "", "waiting for a message", 10*time.Hour)
			require.NoError(t, err)
			at := func(d time.Duration) string { return time.Now().Add(d).UTC().Format(time.RFC3339Nano) }
			_, err = r.h.ts.InsertAgentEvent(r.ctx, &store.AgentEvent{AgentName: "dev", SessionID: &r.sid, EventType: tc.later, CreatedAt: at(time.Minute)})
			require.NoError(t, err)
			if tc.later != "stop" { // the job's turn ended too, so the last event is a stop and only the footer is left to decide
				_, err = r.h.ts.InsertAgentEvent(r.ctx, &store.AgentEvent{AgentName: "dev", SessionID: &r.sid, EventType: "stop", CreatedAt: at(2 * time.Minute)})
				require.NoError(t, err)
			}
			assert.Equal(t, tc.asleep, r.pass(t).IsSleeping, name)
		})
	}
}

// A background marker is in the log with the footer text that said so, so a verdict that keeps an agent awake can be checked against its screen (#12335).
func TestAutoSleepLogsTheFooterThatSaidBackground(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })
	r := newSleepRig(t)
	r.term.screen = "✻ Cogitated for 4s · done 5:38 PM · 1 shell still running\n\n──────────────────────────────────────────────────────────────────────\n❯ \n──────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage\n"
	r.pass(t)
	assert.Contains(t, buf.String(), "reason=background_running")
	assert.Contains(t, buf.String(), "1 shell", "the marker is in the line: "+buf.String())
}

// The wait's own command is an event at the wait's time (its tool_use): it is not "something after the wait", and the turn that backgrounded it then ended with a stop. That worker sleeps (QA's SHOULD,
// #12335: without this the v2.0.34 bug, every parked worker kept awake, could come back unnoticed).
func TestAWorkerWhoseLastToolIsItsOwnWaitCommandSleeps(t *testing.T) {
	const oneShell = "✻ Cogitated for 4s · done 5:38 PM · 1 shell still running\n\n──────────────────────────────────────────────────────────────────────\n❯ \n──────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage\n"
	r := newSleepRig(t)
	r.term.screen = oneShell
	at := func(d time.Duration) string { return time.Now().Add(d).UTC().Format(time.RFC3339Nano) }
	_, err := r.h.ts.InsertAgentEvent(r.ctx, &store.AgentEvent{AgentName: "dev", SessionID: &r.sid, EventType: "tool_use", CreatedAt: at(-time.Second)}) // `coral-board wait`, just before it registered
	require.NoError(t, err)
	_, err = r.h.bs.RegisterWait(r.ctx, "autosleep", "dev", r.name, "message", "", "waiting for a message", 10*time.Hour)
	require.NoError(t, err)
	_, err = r.h.ts.InsertAgentEvent(r.ctx, &store.AgentEvent{AgentName: "dev", SessionID: &r.sid, EventType: "stop", CreatedAt: at(20 * time.Second)})
	require.NoError(t, err)
	assert.Equal(t, 1, r.pass(t).IsSleeping, "the tool at the wait's own time is the wait's command, not a job: asleep")
}
