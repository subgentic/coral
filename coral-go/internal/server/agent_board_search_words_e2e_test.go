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

// The blind testers' findings on the agent's search (#19423, goal #244): words in any order, no task-queue notices by default, and --sort oldest that is obeyed.
func TestAgentBoardSearchTakesWordsInAnyOrderLeavesSystemNoticesOutAndObeysSort(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	a, err := bs.CreateBoard(ctx, "team-w", "Operator")
	require.NoError(t, err)
	_, err = bs.CreateGoal(ctx, a.ID, board.GoalInput{Title: "Billing export", Outcome: "customers export invoices every month", CreatedBy: "op"})
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, a.ID, "Fix expired certificate", "The deploy of the staging cluster failed: the TLS certificate expired.", "high", "orch")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, a.ID, "Dana", "Lead", "", nil, "all")
	require.NoError(t, err)
	first, err := bs.PostMessage(ctx, a.ID, "Dana", "we decided the staging certificate is renewed on Friday", nil)
	require.NoError(t, err)
	sys, err := bs.PostSystemMessage(ctx, a.ID, "Coral Task Queue", "[Task #1 (high)] Fix expired certificate on staging", nil)
	require.NoError(t, err)
	last, err := bs.PostMessage(ctx, a.ID, "Dana", "the certificate on staging was renewed", nil)
	require.NoError(t, err)

	sid := "eeeeeeee-1105-4000-8000-0000000019b1"
	boardKey := a.ID
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &boardKey}))
	tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, a.ID, "Dev-bbbb", "Dev", "claude-"+sid, nil, "all")
	require.NoError(t, err)

	search := func(params url.Values) []map[string]any {
		req, _ := http.NewRequest("GET", ts.URL+"/api/agent/board/search?"+params.Encode(), nil)
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		require.Equal(t, http.StatusOK, resp.StatusCode, string(raw))
		var out struct {
			Results []map[string]any `json:"results"`
		}
		require.NoError(t, json.Unmarshal(raw, &out))
		return out.Results
	}
	ids := func(res []map[string]any, source string) []int64 {
		var out []int64
		for _, r := range res {
			if r["source"] == source {
				out = append(out, int64(r["id"].(float64)))
			}
		}
		return out
	}

	t.Run("words in any order find the task, the goal and the posts", func(t *testing.T) {
		res := search(url.Values{"q": {"certificate staging"}})
		assert.Len(t, ids(res, "task"), 1)
		assert.Equal(t, []int64{last.ID, first.ID}, ids(res, "message"), "the two posts of people, the best match first")
		res = search(url.Values{"q": {"invoices month customers"}, "source": {"goals"}})
		assert.Len(t, ids(res, "goal"), 1)
		assert.Empty(t, search(url.Values{"q": {"certificate nonsuchword"}}), "a word that is nowhere makes no match")
	})
	t.Run("the task queue's notices are left out unless asked for", func(t *testing.T) {
		assert.NotContains(t, ids(search(url.Values{"q": {"certificate"}, "source": {"messages"}}), "message"), sys.ID)
		assert.Contains(t, ids(search(url.Values{"q": {"certificate"}, "source": {"messages"}, "system": {"1"}}), "message"), sys.ID)
		assert.Equal(t, []int64{sys.ID}, ids(search(url.Values{"q": {"certificate"}, "source": {"messages"}, "from": {"Coral Task Queue"}}), "message"), "named with from: the sender asked for")
	})
	t.Run("sort oldest is obeyed", func(t *testing.T) {
		assert.Equal(t, []int64{last.ID, first.ID}, ids(search(url.Values{"q": {"certificate"}, "source": {"messages"}}), "message"))
		assert.Equal(t, []int64{first.ID, last.ID}, ids(search(url.Values{"q": {"certificate"}, "source": {"messages"}, "sort": {"oldest"}}), "message"))
	})
}
