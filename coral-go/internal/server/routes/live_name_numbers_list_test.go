package routes

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// The live list the dashboard polls and the feed it is pushed carry name_number: two agents nobody named, in one folder, are 1 and 2; a named one and a lone agent are 1 (#10249).
func TestTheLiveListNumbersTwoUnnamedAgentsInOneFolder(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	term := newMockTerminal()
	h := NewSessionsHandler(db, &config.Config{LogDir: t.TempDir(), CoralRoot: "/home/someone"}, nil, term, nil)
	named := "Mine"
	for i, sid := range []string{"11111111-0000-0000-0000-000000000001", "22222222-0000-0000-0000-000000000002", "33333333-0000-0000-0000-000000000003"} {
		term.addSession("claude-"+sid, "/home/someone")
		require.NoError(t, h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "someone", WorkingDir: "/home/someone"}))
		if i == 2 { // a person's rename is stored by the display-name route
			require.NoError(t, h.ss.SetDisplayName(ctx, sid, named))
		}
	}
	rows, err := h.buildSessionListForWS(httptest.NewRequest("GET", "/ws/coral", nil))
	require.NoError(t, err)
	h.orderLiveRows(ctx, rows)
	got := map[string]any{}
	for _, r := range rows {
		got[r["session_id"].(string)] = r["name_number"]
	}
	assert.Len(t, got, 3)
	nums := map[int]int{}
	for sid, n := range got {
		v, ok := n.(int)
		require.True(t, ok, "every row has name_number: %s %v", sid, n)
		nums[v]++
	}
	assert.Equal(t, map[int]int{1: 2, 2: 1}, nums, "one unnamed agent keeps the plain name, the other is 2, the named one is 1: %v", got)
	assert.Equal(t, 1, got["33333333-0000-0000-0000-000000000003"], "the named agent is never numbered")
}

// QA's repro on #10249: the numbers follow the order the agents were started, not the list's order (awake before sleeping). a was started first: it is Claude, b is Claude 2, whether or not a sleeps.
func TestNumbersDoNotSwapWhenTheFirstAgentSleeps(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	term := newMockTerminal()
	h := NewSessionsHandler(db, &config.Config{LogDir: t.TempDir(), CoralRoot: "/home/someone"}, nil, term, nil)
	a, b := "11111111-0000-0000-0000-00000000000a", "22222222-0000-0000-0000-00000000000b"
	for _, sid := range []string{a, b} { // registered in this order: a first
		term.addSession("claude-"+sid, "/home/someone")
		require.NoError(t, h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "someone", WorkingDir: "/home/someone"}))
	}
	numbersOf := func() map[string]any {
		rows, err := h.buildSessionListForWS(httptest.NewRequest("GET", "/ws/coral", nil))
		require.NoError(t, err)
		h.orderLiveRows(ctx, rows)
		got := map[string]any{}
		for _, r := range rows {
			got[r["session_id"].(string)] = r["name_number"]
		}
		return got
	}
	assert.Equal(t, map[string]any{a: 1, b: 2}, numbersOf(), "both awake")
	require.NoError(t, h.ss.SetSessionSleeping(ctx, a, true))
	assert.Equal(t, map[string]any{a: 1, b: 2}, numbersOf(), "a asleep: the numbers do not swap")
	require.NoError(t, h.ss.SetSessionSleeping(ctx, a, false))
	assert.Equal(t, map[string]any{a: 1, b: 2}, numbersOf(), "a awake again")
}
