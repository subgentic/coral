package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// coral-search slice 3 (#19237, goal #244): the dashboard's search of tasks and goals is the search 'coral-board search' makes. One query to each returns the same hits, in the same shape and order, so a word only in a
// task's body or a goal's outcome is found in the dashboard as it is from an agent's shell; another team's tasks never appear in either.
func TestDashboardWorkSearchReturnsTheSameHitsAsTheAgentSearch(t *testing.T) {
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
	_, err = bs.CreateTask(ctx, a.ID, "Plain title", "body with a narwhal in it", "high", "orch")
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, a.ID, "Second", "another narwhal and a zebrafish", "high", "orch")
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, b.ID, "Other team", "narwhal zebrafish secret", "high", "orch")
	require.NoError(t, err)

	sid := "eeeeeeee-1105-4000-8000-0000000019a2"
	boardKey := a.ID
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &boardKey}))
	tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, a.ID, "Dev-aaaa", "Dev", "claude-"+sid, nil, "all")
	require.NoError(t, err)

	get := func(req *http.Request) (int, json.RawMessage, string) {
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out struct {
			Results json.RawMessage `json:"results"`
		}
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out.Results, string(raw)
	}
	agent := func(params url.Values) (int, json.RawMessage, string) {
		req, _ := http.NewRequest("GET", ts.URL+"/api/agent/board/search?"+params.Encode(), nil)
		req.Header.Set(store.SessionTokenHeader, tok)
		return get(req)
	}
	dash := func(params url.Values) (int, json.RawMessage, string) {
		req, _ := http.NewRequest("GET", ts.URL+"/api/board/"+a.ID+"/search?"+params.Encode(), nil)
		return get(req)
	}
	for _, params := range []url.Values{
		{"q": {"narwhal"}, "source": {"tasks"}},
		{"q": {"zebrafish"}, "source": {"tasks,goals"}},
		{"q": {"zebrafish"}, "source": {"goals"}},
		{"q": {"narwhal"}, "source": {"tasks"}, "state": {"blocked"}},
		{"q": {"zebrafish"}, "source": {"tasks,goals"}, "goal": {strconv.FormatInt(g.ID, 10)}},
		{"q": {"narwhal"}, "source": {"tasks"}, "limit": {"1"}},
		{"q": {"nothing-matches-this"}, "source": {"tasks,goals"}},
	} {
		wantCode, want, wantRaw := agent(params)
		code, got, raw := dash(params)
		require.Equal(t, http.StatusOK, wantCode, wantRaw)
		require.Equal(t, http.StatusOK, code, raw)
		assert.JSONEq(t, string(want), string(got), "the same hits for "+params.Encode()+": agent "+wantRaw+" dashboard "+raw)
		assert.NotContains(t, raw, "secret")
		assert.NotContains(t, raw, "Other team")
	}
	t.Run("what it finds", func(t *testing.T) {
		_, _, raw := dash(url.Values{"q": {"narwhal"}, "source": {"tasks"}})
		assert.Contains(t, raw, "Plain title")
		assert.Contains(t, raw, "Second")
		_, _, raw = dash(url.Values{"q": {"zebrafish"}, "source": {"goals"}})
		assert.Contains(t, raw, "Ship it")
	})
	t.Run("messages keep their own search, and bad input is refused", func(t *testing.T) {
		for _, bad := range []url.Values{{"q": {"x"}, "bogus": {"1"}}, {"q": {"x"}, "source": {"bogus"}}, {"q": {"x"}, "goal": {"abc"}}, {"q": {"x"}, "state": {"queued"}}} {
			code, _, _ := dash(bad)
			assert.Equal(t, http.StatusBadRequest, code, bad.Encode())
		}
		_, _, raw := dash(url.Values{"q": {"narwhal"}, "source": {"messages"}}) // no messages here: tasks and goals only
		assert.NotContains(t, raw, `"source":"message"`)
	})
}
