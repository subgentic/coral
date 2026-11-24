package routes

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// Brief task 5 (#21019): a team template carries reminders per role, and launching the team creates them for the members it starts, within today's reminder limits
// (an agent's reminder repeats at most every 15 minutes, at most 20 on one agent; no secret, no sign-in link).
func TestLaunchingATemplateWithRemindersCreatesThem(t *testing.T) {
	e := newLaunchEnv(t)
	ch := NewChiefChecksHandler(e.h.db, e.h)
	e.h.SetTemplateReminders(ch.AddTemplateReminders)
	code, out := e.post("/api/sessions/launch-team", e.h.LaunchTeam, map[string]any{"working_dir": t.TempDir(), "board_name": "overnight", "agent_type": "claude", "agents": []map[string]any{
		{"name": "Orchestrator", "prompt": "lead the team", "reminders": []map[string]any{
			{"text": "Write the morning summary of what finished overnight.", "kind": "daily", "at": "07:30", "timezone": "UTC"},
			{"text": "Check that every agent is working.", "kind": "every", "every_minutes": 60},
		}},
		{"name": "Builder", "prompt": "build", "reminders": []map[string]any{
			{"text": "Too fast: every 5 minutes.", "kind": "every", "every_minutes": 5},
			{"text": "Mail the token sk-ant-api03-" + strings.Repeat("A", 40), "kind": "daily", "at": "09:00", "timezone": "UTC"},
			{"text": "Fine.", "kind": "weekdays", "at": "09:00", "timezone": "UTC"},
		}},
		{"name": "Reviewer", "prompt": "review"},
	}})
	require.Equal(t, http.StatusOK, code, "%v", out)

	sidOf := map[string]string{}
	notes := map[string]any{}
	for _, a := range out["agents"].([]any) {
		m := a.(map[string]any)
		sidOf[m["name"].(string)], _ = m["session_id"].(string)
		notes[m["name"].(string)] = m["reminders"]
	}
	checks, err := ch.sched.ChiefChecks(context.Background())
	require.NoError(t, err)
	got := map[string][]store.ChiefCheck{}
	for _, c := range checks {
		if c.IsReminder() {
			got[c.TargetSession] = append(got[c.TargetSession], c)
		}
	}
	require.Len(t, got[sidOf["Orchestrator"]], 2, "both of the Orchestrator's reminders: %v", notes["Orchestrator"])
	assert.Len(t, got[sidOf["Builder"]], 1, "the 5-minute one and the one with a secret are refused; the weekday one is kept")
	assert.Empty(t, got[sidOf["Reviewer"]], "a role with none has none")
	for _, c := range got[sidOf["Orchestrator"]] {
		assert.Equal(t, "operator", c.Origin, "set by the person who launched the template")
		assert.Equal(t, "overnight", c.TargetBoard)
	}
	assert.Contains(t, fmt.Sprint(notes["Builder"]), "every 15 minutes", "what was left out is said in the launch reply")
}
