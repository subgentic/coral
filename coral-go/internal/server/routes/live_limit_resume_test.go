package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #20691: a live row of an agent Coral will resume at its limit's reset carries limit_resume_at (when, RFC 3339, UTC), for the limit view; every other row has no such key, and a sleeping agent's never does.
func TestALiveRowShowsWhenCoralWillResumeItAtItsLimitsReset(t *testing.T) {
	server, _, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const pending, plain, asleep = "cccccccc-2069-4000-8000-000000000001", "cccccccc-2069-4000-8000-000000000002", "cccccccc-2069-4000-8000-000000000003"
	for _, sid := range []string{pending, plain, asleep} {
		if sid != asleep {
			mock.addSession(naming.SessionName("codex", sid), "/tmp/project")
		}
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "a-" + sid[len(sid)-1:], AgentType: "codex", WorkingDir: "/tmp/project"}))
	}
	require.NoError(t, ss.SetSessionSleepingFor(ctx, asleep, ""))
	at := time.Date(2026, 11, 22, 22, 7, 15, 0, time.UTC)
	ptymanager.NoteLimitResume(pending, at)
	ptymanager.NoteLimitResume(asleep, at)
	t.Cleanup(func() {
		for _, sid := range []string{pending, plain, asleep} {
			ptymanager.NoteLimitResume(sid, time.Time{})
		}
	})

	rows := liveRows(t, server.URL)
	assert.Equal(t, "2026-11-22T22:07:15Z", rows[pending]["limit_resume_at"])
	for _, sid := range []string{plain, asleep} {
		_, has := rows[sid]["limit_resume_at"]
		assert.False(t, has, "row %s has no limit_resume_at", sid)
	}
	ptymanager.NoteLimitResume(pending, time.Time{}) // sent or cancelled
	_, has := liveRows(t, server.URL)[pending]["limit_resume_at"]
	assert.False(t, has)
}
