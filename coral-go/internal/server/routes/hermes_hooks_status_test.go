package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
)

// #12041 (goal #192 slice E), as the Orchestrator set it after the tester's evidence: Hermes sends no hook event until its first turn (about 80 s on a first-use home), so a launch, a welcome line or a quiet
// five minutes prove nothing. The status lists a Hermes agent only when its own state.db shows a user turn at least hermesHooksGrace old and the agent has recorded no hook event at all.
func TestHooksStatusListsHermesAgentsWhoseHooksNeverReportedAfterATurn(t *testing.T) {
	r := newWakeRig(t)
	r.h.cfg.UseCoralDir(t.TempDir()) // the Hermes homes of the agents below
	ctx := context.Background()
	team := "t1"
	reg := func(sid, name, agentType string) {
		t.Helper()
		require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: agentType, WorkingDir: t.TempDir(), BoardName: &team}))
	}
	turn := func(sid string, role string, at time.Time) {
		t.Helper()
		w := writeHermesState(t, agent.HermesAgentHome(r.h.cfg.CoralDir(), team, sid))
		_, err := w.Exec(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('local-x', ?, 'hi', ?)`, role, float64(at.Unix()))
		require.NoError(t, err)
	}
	id := func(n string) string { return "bbbbbbbb-1204-4000-8000-00000000000" + n }
	const hookless, healthy, young, noTurn, assistantOnly, asleep, other, noted = "1", "2", "3", "4", "5", "6", "7", "8"
	now := time.Now()
	old := now.Add(-2*hermesHooksGrace - time.Minute)
	for n, name := range map[string]string{hookless: "hookless", healthy: "healthy", young: "young", noTurn: "noturn", assistantOnly: "assistantonly", asleep: "asleep", noted: "noted"} {
		reg(id(n), name, "hermes")
	}
	reg(id(other), "pi-agent", "pi")
	require.NoError(t, r.ss.SetSessionSleeping(ctx, id(asleep), true))
	turn(id(hookless), "user", old)                   // a turn long ago, no hook event: listed
	turn(id(healthy), "user", old)                    // a turn long ago, and its hooks reported: not listed
	turn(id(young), "user", now.Add(-30*time.Second)) // a turn, but a young one: the hooks are not yet due
	// noTurn: a state.db with no row, or none at all: healthy and quiet
	turn(id(assistantOnly), "assistant", old) // no user turn
	turn(id(asleep), "user", old)
	turn(id(noted), "user", old) // only a notice Coral wrote: not a hook event
	for _, n := range []string{healthy} {
		sid := id(n)
		_, err := store.NewTaskStore(r.h.db).InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "x", SessionID: &sid, EventType: "prompt_submit", Summary: "x"})
		require.NoError(t, err)
	}
	notedID := id(noted)
	_, err := store.NewTaskStore(r.h.db).InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "x", SessionID: &notedID, EventType: "agent_notice", Summary: "its first message was not typed"})
	require.NoError(t, err)

	sessions, err := r.ss.GetAllLiveSessions(ctx)
	require.NoError(t, err)
	var names []string
	for _, a := range r.h.hermesHooksInactive(ctx, sessions, now) {
		names = append(names, a.Name+":"+a.Status)
	}
	assert.ElementsMatch(t, []string{"hookless:inactive", "noted:inactive"}, names,
		"a user turn at least two minutes old and no hook event: not an agent that reported, a young turn, no turn yet, an assistant-only file, a sleeping agent or another type; a notice Coral wrote is not a hook event")

	// The turn ages into the list: the same agent, three minutes later.
	var later []string
	for _, a := range r.h.hermesHooksInactive(ctx, sessions, now.Add(3*time.Minute)) {
		later = append(later, a.Name)
	}
	assert.Contains(t, later, "young", "its turn is two minutes old by then, and still no hook event")
	assert.NotContains(t, later, "healthy")
	assert.NotContains(t, later, "noturn", "an agent that never had a turn is never listed, however long it waits")

	req := httptest.NewRequest("GET", "/api/system/hooks-status", nil)
	w := httptest.NewRecorder()
	r.h.HooksStatus(w, req)
	var body struct {
		HermesInactive []hooksAgent `json:"hermes_inactive"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.NotNil(t, body.HermesInactive, "the field is always there (an empty list at none)")
}
