package routes

import (
	"context"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Operator (#14859): a broadcast that names no one wakes no sleeping agent. A task nobody is assigned is announced to the board and nudged to one free agent
// picked at random; a sleeper was picked as often as anyone and woken (the idle waker) to be told. Only a named recipient (a mention, a task assigned to the agent,
// the Operator's or the Orchestrator's own wake) wakes.
func TestAnUnassignedTasksNudgeNeverWakesASleepingAgent(t *testing.T) {
	const sleeper, live = "claude-00000007-3864-4864-8864-000000000007", "claude-00000008-3864-4864-8864-000000000008"
	server, handler := setupBoardTestServer(t)
	registerTaskPlanner(t, handler, "myproject", "Orchestrator")
	terminal := newMockTerminal()
	terminal.addSession(sleeper, "/tmp/a")
	terminal.addSession(live, "/tmp/b")
	handler.SetTerminal(terminal)
	handler.SetSessionAsleepLookup(func(_ context.Context, id string) bool { return id == "00000007-3864-4864-8864-000000000007" })
	var mu sync.Mutex
	var asked []string // every session the idle waker was asked about: the live agent's is asked too, and is nothing
	askedSleeper := func() bool {
		mu.Lock()
		defer mu.Unlock()
		return slices.Contains(asked, "00000007-3864-4864-8864-000000000007")
	}
	handler.SetIdleWaker(func(_ context.Context, id string) bool {
		mu.Lock()
		asked = append(asked, id)
		mu.Unlock()
		return true
	})
	base := server.URL + "/api/board/myproject"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Sleeper", "job_title": "Dev", "session_name": sleeper}).Body.Close()

	// only the sleeper is free: the nudge goes to no one, and no one is woken
	resp := postJSON(t, base+"/tasks", map[string]string{"title": "Nobody's one", "created_by": "Orchestrator"})
	resp.Body.Close()
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	assert.Never(t, func() bool { return askedSleeper() || len(terminal.sentTo(sleeper)) > 0 }, 600*time.Millisecond, 20*time.Millisecond, "a broadcast wakes no sleeper and types nothing into one")

	// a live agent is free too: it gets the nudge, however many tasks are made, and the sleeper never does
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Live", "job_title": "Dev", "session_name": live}).Body.Close()
	for i := 0; i < 6; i++ {
		postJSON(t, base+"/tasks", map[string]string{"title": "Nobody's again", "created_by": "Orchestrator"}).Body.Close()
	}
	require.Eventually(t, func() bool {
		for _, s := range terminal.sentTo(live) {
			if s == taskNudge {
				return true
			}
		}
		return false
	}, 3*time.Second, 20*time.Millisecond, "the live agent is told")
	time.Sleep(300 * time.Millisecond) // sleep-ok: the other nudges are in flight; nothing to wait for but their absence
	assert.False(t, askedSleeper(), "no wake for a broadcast")
	assert.Empty(t, terminal.sentTo(sleeper), "nothing typed into the sleeper")
}
