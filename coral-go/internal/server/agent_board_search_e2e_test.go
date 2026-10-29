package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #11005 phase (a): GET /api/agent/board/search, an agent's search of its own board's messages. The board is the ONE launch board named by the session's live row, by board KEY (never a label, never a seat):
// a seat the Operator makes on a foreign board does not widen it, two boards with one label are told apart by key, and every other team's and the Operator's board is out of the results. Every board here
// carries a canary string, so a leak shows as a canary in a result.
func TestAgentBoardSearchIsTheAgentsOwnLaunchBoardByKey(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore

	a, err := bs.CreateBoard(ctx, "team-a", "Operator")
	require.NoError(t, err)
	b, err := bs.CreateBoard(ctx, "team-b", "Operator")
	require.NoError(t, err)
	ops, err := bs.CreateBoard(ctx, "ops", "Operator")
	require.NoError(t, err)
	twin1, err := bs.CreateBoard(ctx, "twin", "Operator")
	require.NoError(t, err)
	twin2, err := bs.CreateBoard(ctx, "twin", "Operator")
	require.NoError(t, err)
	post := func(boardKey, who, text string) {
		_, err := bs.Subscribe(ctx, boardKey, who, "Member", "", nil, "all")
		require.NoError(t, err)
		_, err = bs.PostMessage(ctx, boardKey, who, text, nil)
		require.NoError(t, err)
	}
	post(a.ID, "Lead-A", "CANARY-A the old decision about the release train")
	post(b.ID, "Lead-B", "CANARY-B the old decision about the release train")
	post(ops.ID, "Operator", "CANARY-OPS the old decision about the release train")
	post(twin1.ID, "Lead-T1", "CANARY-T1 the old decision about the release train")
	post(twin2.ID, "Lead-T2", "CANARY-T2 the old decision about the release train")
	for i := 1; i <= 5; i++ {
		post(a.ID, "Lead-A", fmt.Sprintf("PAGEWORD number %d on team a", i))
	}

	agentOn := func(sid, boardKey string) string {
		session := "claude-" + sid
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &boardKey}))
		tok, err := srv.db.MintSessionToken(ctx, sid, session)
		require.NoError(t, err)
		_, err = bs.Subscribe(ctx, boardKey, "Dev-"+sid[:4], "Dev", session, nil, "all")
		require.NoError(t, err)
		return tok
	}
	sidA := "eeeeeeee-1105-4000-8000-00000000000a"
	tokA := agentOn(sidA, a.ID)

	get := func(path, tok string) (int, map[string]any, string) {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		if tok != "" {
			req.Header.Set(store.SessionTokenHeader, tok)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out, string(raw)
	}
	search := func(tok string, params url.Values) (int, map[string]any, string) {
		return get("/api/agent/board/search?"+params.Encode(), tok)
	}

	t.Run("it finds a phrase from an old post on its own board, and no other team's or the Operator's canary", func(t *testing.T) {
		code, out, raw := search(tokA, url.Values{"q": {"old decision"}})
		require.Equal(t, http.StatusOK, code, raw)
		assert.Contains(t, raw, "CANARY-A")
		for _, leak := range []string{"CANARY-B", "CANARY-OPS", "CANARY-T1", "CANARY-T2"} {
			assert.NotContains(t, raw, leak)
		}
		assert.EqualValues(t, 1, out["total"])
		assert.Equal(t, a.ID, out["board"], "it says which board it searched")
		assert.Equal(t, "own", out["reach"])
	})
	t.Run("paging walks every match once", func(t *testing.T) {
		seen := map[string]bool{}
		cursor := ""
		for page := 0; page < 10; page++ {
			params := url.Values{"q": {"PAGEWORD"}, "limit": {"2"}, "sort": {"oldest"}}
			if cursor != "" {
				params.Set("cursor", cursor)
			}
			code, out, raw := search(tokA, params)
			require.Equal(t, http.StatusOK, code, raw)
			msgs, _ := out["messages"].([]any)
			require.LessOrEqual(t, len(msgs), 2)
			for _, m := range msgs {
				content := m.(map[string]any)["content"].(string)
				assert.False(t, seen[content], "no match twice: %s", content)
				seen[content] = true
			}
			cursor, _ = out["next_cursor"].(string)
			if cursor == "" {
				break
			}
		}
		assert.Len(t, seen, 5, "all five matches, once each")
	})
	t.Run("a seat the Operator makes on a foreign board does not widen it", func(t *testing.T) {
		_, err := bs.Subscribe(ctx, b.ID, "Dev-seated", "Dev", "claude-"+sidA, nil, "all") // the Operator seats this session on team-b
		require.NoError(t, err)
		code, _, raw := search(tokA, url.Values{"q": {"CANARY"}})
		require.Equal(t, http.StatusOK, code, raw)
		assert.Contains(t, raw, "CANARY-A")
		assert.NotContains(t, raw, "CANARY-B", "its seat on team-b is not its launch board")
	})
	t.Run("two boards with one label are told apart by key", func(t *testing.T) {
		sidT := "eeeeeeee-1105-4000-8000-00000000000b"
		tokT := agentOn(sidT, twin1.ID)
		code, _, raw := search(tokT, url.Values{"q": {"CANARY"}})
		require.Equal(t, http.StatusOK, code, raw)
		assert.Contains(t, raw, "CANARY-T1")
		assert.NotContains(t, raw, "CANARY-T2", "the other board with the same label")
	})
	t.Run("a reach above own is refused with 403 search_reach_refused and no data", func(t *testing.T) {
		for _, reach := range []string{"team", "all", "operator"} {
			code, out, raw := search(tokA, url.Values{"q": {"CANARY"}, "reach": {reach}})
			assert.Equal(t, http.StatusForbidden, code, "%s: %s", reach, raw)
			assert.Equal(t, "search_reach_refused", out["code"], reach)
			assert.Equal(t, reach, out["requested"], reach)
			assert.Equal(t, "own", out["level"], reach)
			assert.NotContains(t, raw, "CANARY", "%s: a refusal carries no results", reach)
		}
		code, _, _ := search(tokA, url.Values{"q": {"x"}, "reach": {"everything"}})
		assert.Equal(t, http.StatusBadRequest, code, "an unknown reach is a bad request, not a quiet narrowing")
	})
	t.Run("who is asking is the token's session, never a claim", func(t *testing.T) {
		code, _, _ := search("", url.Values{"q": {"CANARY"}})
		assert.NotEqual(t, http.StatusOK, code, "no token: nothing")
		code, _, _ = search("not-a-real-token", url.Values{"q": {"CANARY"}})
		assert.NotEqual(t, http.StatusOK, code, "a wrong token: nothing")
		sidT := "eeeeeeee-1105-4000-8000-00000000000b"
		tokT := agentOn("eeeeeeee-1105-4000-8000-00000000000c", twin2.ID) // another agent, on another board
		_ = sidT
		code, _, raw := search(tokT, url.Values{"q": {"CANARY"}, "session_id": {sidA}})
		assert.Equal(t, http.StatusForbidden, code, "its token cannot ask as another session: %s", raw)
		assert.NotContains(t, raw, "CANARY-A")
	})
	t.Run("a session with no recorded board has nothing to search, and a bad parameter is named", func(t *testing.T) {
		sidN := "eeeeeeee-1105-4000-8000-00000000000d"
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sidN, AgentType: "claude", AgentName: "solo", WorkingDir: "/w"}))
		tokN, err := srv.db.MintSessionToken(ctx, sidN, "claude-"+sidN)
		require.NoError(t, err)
		code, _, raw := search(tokN, url.Values{"q": {"CANARY"}})
		assert.Equal(t, http.StatusForbidden, code, raw)
		assert.NotContains(t, raw, "CANARY-")
		code, _, raw = search(tokA, url.Values{"q": {"x"}, "bogus": {"1"}})
		assert.Equal(t, http.StatusBadRequest, code)
		assert.Contains(t, strings.ToLower(raw), "bogus")
	})
}
