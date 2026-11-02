package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #12041 (goal #192 slice E): a Hermes agent's hooks are shell hooks in its team's config.yaml, and a launch proves nothing about them (a hook tool Hermes refuses, a changed config, a Hermes that
// changed its events). The status lists a Hermes agent Coral launched in this server run, silent for hermesHooksGrace with no event of its session at all; it never lists one it cannot be sure of, and
// it never touches the agent's state.
func TestHooksStatusListsHermesAgentsWhoseHooksNeverReported(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	reg := func(sid, name, agentType string) {
		t.Helper()
		team := "t1"
		require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: agentType, WorkingDir: t.TempDir(), BoardName: &team}))
	}
	const silent, fresh, said, unknown, asleep, other = "bbbbbbbb-12041-4000-8000-000000000001", "bbbbbbbb-12041-4000-8000-000000000002", "bbbbbbbb-12041-4000-8000-000000000003", "bbbbbbbb-12041-4000-8000-000000000004", "bbbbbbbb-12041-4000-8000-000000000005", "bbbbbbbb-12041-4000-8000-000000000006"
	reg(silent, "silent", "hermes")
	reg(fresh, "fresh", "hermes")
	reg(said, "said", "hermes")
	reg(unknown, "unknown", "hermes")
	reg(asleep, "asleep", "hermes")
	reg(other, "pi-agent", "pi")
	require.NoError(t, r.ss.SetSessionSleeping(ctx, asleep, true))
	now := time.Now()
	long := now.Add(-2 * hermesHooksGrace)
	r.h.hermesLaunchedAt.Store(silent, long)
	r.h.hermesLaunchedAt.Store(fresh, now.Add(-10*time.Second))
	r.h.hermesLaunchedAt.Store(said, long)
	r.h.hermesLaunchedAt.Store(asleep, long)
	r.h.hermesLaunchedAt.Store(other, long)
	// unknown: an agent started before this server run has no launch time
	sid := said
	_, err := store.NewTaskStore(r.h.db).InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "said", SessionID: &sid, EventType: "prompt_submit", Summary: "x"})
	require.NoError(t, err)

	sessions, err := r.ss.GetAllLiveSessions(ctx)
	require.NoError(t, err)
	var names []string
	for _, a := range r.h.hermesHooksInactive(ctx, sessions, now) {
		names = append(names, a.Name+":"+a.Status)
	}
	assert.Equal(t, []string{"silent:inactive"}, names, "only a Hermes agent launched in this server run, silent past the grace; not one that reported, a fresh one, one with no launch time, a sleeping one, or another type")

	// A restart or wake starts the clock again.
	r.h.noteLaunchedHooks(ctx, silent, "hermes")
	assert.Empty(t, r.h.hermesHooksInactive(ctx, sessions, now.Add(30*time.Second)), "its clock restarted at the launch")
	var again []string
	for _, a := range r.h.hermesHooksInactive(ctx, sessions, now.Add(2*hermesHooksGrace)) {
		again = append(again, a.Name)
	}
	assert.Contains(t, again, "silent", "and it is listed again after the grace")
	assert.NotContains(t, again, "said", "an agent that reported is never listed")

	req := httptest.NewRequest("GET", "/api/system/hooks-status", nil)
	w := httptest.NewRecorder()
	r.h.HooksStatus(w, req)
	var body struct {
		HermesInactive []hooksAgent `json:"hermes_inactive"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.NotNil(t, body.HermesInactive, "the field is always there (an empty list at none)")
}
