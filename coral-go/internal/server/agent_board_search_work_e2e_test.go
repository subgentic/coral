package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// coral-search slice 1 (#19161, goal #244): the agent's search of its own board also finds tasks and goals, in one result shape, with --source and the task filters. Another team's tasks and goals never appear.
func TestAgentBoardSearchFindsTasksGoalsAndMessagesBySource(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	a, err := bs.CreateBoard(ctx, "team-a", "Operator")
	require.NoError(t, err)
	b, err := bs.CreateBoard(ctx, "team-b", "Operator")
	require.NoError(t, err)
	g, err := bs.CreateGoal(ctx, a.ID, board.GoalInput{Title: "Ship it", Outcome: "the zebrafish habitat lands", CreatedBy: "op"})
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, a.ID, "Plain", "body with a narwhal in it", "high", "orch")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, a.ID, "Lead-A", "Lead", "", nil, "all")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, a.ID, "Lead-A", "a post about the pangolin", nil)
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, b.ID, "Other team", "narwhal zebrafish pangolin secret", "high", "orch")
	require.NoError(t, err)
	_, err = bs.CreateGoal(ctx, b.ID, board.GoalInput{Title: "narwhal zebrafish pangolin other goal", CreatedBy: "op"})
	require.NoError(t, err)

	sid := "eeeeeeee-1105-4000-8000-0000000019a1"
	boardKey := a.ID
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &boardKey}))
	tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, a.ID, "Dev-aaaa", "Dev", "claude-"+sid, nil, "all")
	require.NoError(t, err)

	search := func(params url.Values) (int, []map[string]any, string) {
		req, _ := http.NewRequest("GET", ts.URL+"/api/agent/board/search?"+params.Encode(), nil)
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out struct {
			Results []map[string]any `json:"results"`
		}
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out.Results, string(raw)
	}
	sources := func(results []map[string]any) map[string]int {
		m := map[string]int{}
		for _, r := range results {
			m[r["source"].(string)]++
		}
		return m
	}
	for _, tc := range []struct{ word, source, wantSource string }{
		{"narwhal", "tasks", "task"},
		{"zebrafish", "goals", "goal"},
		{"pangolin", "messages", "message"},
	} {
		code, res, raw := search(url.Values{"q": {tc.word}, "source": {tc.source}})
		require.Equal(t, http.StatusOK, code, raw)
		assert.Equal(t, map[string]int{tc.wantSource: 1}, sources(res), tc.word+" in "+tc.source+": "+raw)
		assert.NotContains(t, raw, "secret")
		assert.NotContains(t, raw, "other goal")
		code, res, raw = search(url.Values{"q": {tc.word}}) // every source by default
		require.Equal(t, http.StatusOK, code, raw)
		assert.Equal(t, 1, sources(res)[tc.wantSource], raw)
		for _, other := range []string{"tasks", "goals", "messages"} { // the word is in one source only
			if other == tc.source {
				continue
			}
			_, res, raw = search(url.Values{"q": {tc.word}, "source": {other}})
			assert.Empty(t, res, tc.word+" in "+other+": "+raw)
		}
	}
	t.Run("the result shape is stable", func(t *testing.T) {
		_, res, raw := search(url.Values{"q": {"zebrafish"}, "source": {"goals"}})
		require.Len(t, res, 1, raw)
		for _, k := range []string{"source", "id", "title", "snippet", "state", "at"} {
			assert.Contains(t, res[0], k)
		}
		assert.EqualValues(t, g.ID, res[0]["id"])
		assert.Equal(t, "active", res[0]["state"])
	})
	t.Run("filters and bad input", func(t *testing.T) {
		code, res, raw := search(url.Values{"q": {"narwhal"}, "state": {"completed"}})
		require.Equal(t, http.StatusOK, code, raw)
		assert.Empty(t, res)
		for _, bad := range []url.Values{{"q": {"x"}, "source": {"history"}}, {"q": {"x"}, "source": {"bogus"}}, {"q": {"x"}, "goal": {"abc"}}} {
			code, _, _ = search(bad)
			assert.Equal(t, http.StatusBadRequest, code, bad.Encode())
		}
	})
}
