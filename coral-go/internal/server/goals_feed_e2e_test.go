package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #7116 / UI/UX's question on #7223: through the real router, a browser's /ws/coral socket gets each board's goals brief (the open count and the change counter, no text) in its first frame, and a later
// frame carries it when a goal is written, with a board's goal that is open counted. Before this the feed's goals fields were covered by frame-level tests only.
func TestTheLiveFeedCarriesTheGoalsBriefThroughTheRealRouter(t *testing.T) {
	dir := t.TempDir()
	cfg := newE2EConfig(t, dir)
	cfg.StrictLocalAuth = true
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := mustServer(NewWithKey(cfg, db, stack.backend, stack.terminal, ""))
	t.Cleanup(srv.Close)
	local := httptest.NewServer(srv.Router())
	t.Cleanup(local.Close)
	require.NotNil(t, srv.boardStore)

	ctx := context.Background()
	g, err := srv.boardStore.CreateGoal(ctx, "team-a", board.GoalInput{Title: "Ship it", CreatedBy: "Orchestrator"})
	require.NoError(t, err)

	r := httptest.NewRequest("GET", local.URL+"/", nil)
	tok, err := srv.keyStore.NewSession(r, auth.SessionByPassword, false)
	require.NoError(t, err)
	cookie := &http.Cookie{Name: srv.keyStore.SessionCookieName(r), Value: tok}
	dctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	conn, _, err := websocket.Dial(dctx, "ws"+strings.TrimPrefix(local.URL, "http")+"/ws/coral", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {local.URL}, "Cookie": {cookie.String()}}})
	require.NoError(t, err)
	t.Cleanup(func() { conn.CloseNow() })

	// frame reads frames until one satisfies want, or the wait ends.
	frame := func(want func(map[string]any) bool) map[string]any {
		t.Helper()
		for {
			_, b, err := conn.Read(dctx)
			require.NoError(t, err, "the feed ended before the frame wanted")
			var m map[string]any
			require.NoError(t, json.Unmarshal(b, &m))
			if want(m) {
				return m
			}
		}
	}
	first := frame(func(m map[string]any) bool { return m["type"] == "coral_update" })
	brief, ok := first["goals_brief"].(map[string]any)
	require.True(t, ok, "the first frame carries goals_brief: %v", first)
	a, _ := brief["team-a"].(map[string]any)
	assert.EqualValues(t, 1, a["open"], "one open goal on the board")
	assert.EqualValues(t, 1, first["goals_open"])
	seq := a["seq"]
	assert.NotContains(t, string(mustJSON(t, first)), "Ship it", "no goal text in the feed")

	// A goal write moves the board's counter and the next frame carries the brief again.
	_, _, err = srv.boardStore.CloseGoal(ctx, "team-a", g.ID, "done", "")
	require.NoError(t, err)
	next := frame(func(m map[string]any) bool { _, has := m["goals_brief"]; return has && m["type"] != "coral_update" })
	moved, _ := next["goals_brief"].(map[string]any)
	b2, _ := moved["team-a"].(map[string]any)
	assert.EqualValues(t, 0, b2["open"])
	assert.NotEqual(t, seq, b2["seq"], "the change counter moved")
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return b
}
