package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19162: coral-board remind turns what a person types into the reminders API's body.
func TestBuildReminderFromTheOptions(t *testing.T) {
	now := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)

	body, said, err := buildReminder("Check CI", "2h", "", "", "", "", "", "", now)
	require.NoError(t, err)
	assert.Equal(t, map[string]any{"text": "Check CI", "kind": "once", "timezone": "UTC", "at": "2026-11-17T11:00"}, body, "a time from now is one UTC minute, so no zone is needed")
	assert.Contains(t, said, "once, at ")

	body, _, err = buildReminder("Poll", "", "", "15m", "", "", "", "", now)
	require.NoError(t, err)
	assert.Equal(t, "every", body["kind"])
	assert.Equal(t, 15, body["every_minutes"])

	body, said, err = buildReminder("Standup", "", "", "", "", "09:30", "", "Europe/Berlin", now)
	require.NoError(t, err)
	assert.Equal(t, map[string]any{"text": "Standup", "kind": "weekdays", "at": "09:30", "timezone": "Europe/Berlin"}, body)
	assert.Contains(t, said, "Monday to Friday at 09:30 (Europe/Berlin)")

	body, _, err = buildReminder("Daily", "", "", "", "08:00", "", "", "UTC", now)
	require.NoError(t, err)
	assert.Equal(t, "daily", body["kind"])

	_, _, err = buildReminder("", "2h", "", "", "", "", "", "", now)
	assert.Error(t, err, "no text")
	_, _, err = buildReminder("x", "", "", "", "", "", "", "", now)
	assert.Error(t, err, "no time")
	_, _, err = buildReminder("x", "2h", "", "15m", "", "", "", "", now)
	assert.Error(t, err, "two times")
	_, _, err = buildReminder("x", "soon", "", "", "", "", "", "", now)
	assert.Error(t, err, "not a time")
	_, _, err = buildReminder("x", "", "", "7s", "", "", "", "", now)
	assert.Error(t, err, "not whole minutes")
}

func TestEveryMinutesReadsAMinuteCount(t *testing.T) {
	for in, want := range map[string]int{"15m": 15, "1h": 60, "30": 30, " 5m ": 5} {
		got, err := everyMinutes(in)
		require.NoError(t, err, in)
		assert.Equal(t, want, got, in)
	}
	for _, bad := range []string{"", "0m", "-5m", "90s", "x"} {
		_, err := everyMinutes(bad)
		assert.Error(t, err, bad)
	}
}

// The call goes to /api/reminders with the body as built, and an answer other than the expected one is an error text, not a crash.
func TestRemindCallSendsTheBodyToTheRemindersAPI(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"id": 7, "target_name": "Dev"}`))
	}))
	defer srv.Close()
	old := serverURL
	serverURL = srv.URL
	defer func() { serverURL = old }()

	out := remindCall("POST", "/reminders", map[string]any{"text": "Check CI", "kind": "once", "at": "2026-11-17T11:00", "timezone": "UTC", "board": "team-a"}, "adding the reminder", 201)
	assert.Equal(t, "POST", gotMethod)
	assert.Equal(t, "/api/reminders", gotPath)
	assert.Equal(t, "Check CI", gotBody["text"])
	assert.Equal(t, "team-a", gotBody["board"])
	assert.EqualValues(t, 7, out["id"])
}

func TestReminderLineNamesWhoItIsForAndHowItRepeats(t *testing.T) {
	line := reminderLine(map[string]any{"id": 7.0, "state": "open", "schedule_kind": "interval", "every_minutes": 15.0, "target_name": "Dev", "origin": "agent", "name": "Check CI", "enabled": true})
	assert.Equal(t, "#7 [open] every 15 min, for Dev, set by agent: Check CI", line)
	line = reminderLine(map[string]any{"id": 8.0, "state": "none", "schedule_kind": "once", "at": "2026-11-17T11:00", "timezone": "UTC", "target_name": "Helper", "origin": "orchestrator", "name": "Review", "enabled": false})
	assert.Equal(t, "#8 [off] once 2026-11-17T11:00 UTC, for Helper, set by orchestrator: Review", line)
}

// A weekly reminder (#21085): one day of the week and a time, in the given time zone.
func TestBuildReminderWeekly(t *testing.T) {
	now := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	body, said, err := buildReminder("Catch-up", "", "", "", "", "", "Mon 09:00", "Europe/Berlin", now)
	require.NoError(t, err)
	assert.Equal(t, map[string]any{"text": "Catch-up", "kind": "weekly", "at": "Mon 09:00", "timezone": "Europe/Berlin"}, body)
	assert.Contains(t, said, "Mon 09:00")
	_, _, err = buildReminder("x", "", "", "", "08:00", "", "Mon 09:00", "UTC", now)
	require.Error(t, err, "one schedule only")
}
