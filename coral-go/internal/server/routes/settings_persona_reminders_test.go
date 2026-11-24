package routes

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21184: a saved persona may carry an optional "reminders" list in the shape a team template's role uses (#21019), for the New agent panel's Reminders step to
// prefill. Personas are the dashboard's saved_personas settings list, so the field is kept and read back as written; nothing about it is checked on save, and the reminders
// API checks each one when the agent is created.
func TestASavedPersonaKeepsItsRemindersAsWritten(t *testing.T) {
	put, stored := settingsClient(t)
	list := []map[string]any{
		{"name": "Release watcher", "prompt": "Watch the release.", "reminders": []map[string]any{
			{"text": "Morning check", "kind": "daily", "at": "09:00"},
			{"text": "Weekly catch-up", "kind": "weekly", "at": "Mon 09:00", "timezone": "Europe/Warsaw", "no_wake": true},
			{"text": "Poll", "kind": "every", "every_minutes": 30},
		}},
		{"name": "No reminders", "prompt": "Plain."},
	}
	text, err := json.Marshal(list)
	require.NoError(t, err)
	body, err := json.Marshal(map[string]string{"saved_personas": string(text)})
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, put(string(body)))

	got, ok := stored()["saved_personas"].(string)
	require.True(t, ok, "the list is read back as text")
	var back []map[string]any
	require.NoError(t, json.Unmarshal([]byte(got), &back))
	assert.Equal(t, toAny(t, list[0]["reminders"]), back[0]["reminders"], "the reminders come back as written")
	assert.NotContains(t, back[1], "reminders", "a persona with none gets none added")
}

func toAny(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	var out any
	require.NoError(t, json.Unmarshal(b, &out))
	return out
}
