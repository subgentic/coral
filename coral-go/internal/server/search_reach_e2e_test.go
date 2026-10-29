package server

import (
	"bytes"
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

// #11048: the levels of chat search. An agent's level (own, team, all, operator) is on its team member row, only the Operator raises it (an operator-only route), and every search above own is checked against
// the caller's own row, refused with the level needed when it is above it, logged (no text), and rate limited per member. Every board carries a canary so a leak shows as a canary.
func TestSearchReachLevelsOnBoardSearch(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	ts2 := store.NewTeamStore(srv.db)
	bs := srv.boardStore

	boardOf := map[string]string{}
	for _, n := range []string{"alpha", "beta", "ops"} {
		b, err := bs.CreateBoard(ctx, n, "Operator")
		require.NoError(t, err)
		boardOf[n] = b.ID
		_, err = bs.Subscribe(ctx, b.ID, "Lead-"+n, "Lead", "", nil, "all")
		require.NoError(t, err)
		_, err = bs.PostMessage(ctx, b.ID, "Lead-"+n, "CANARY-"+strings.ToUpper(n)+" the old decision", nil)
		require.NoError(t, err)
	}
	// A team whose name is its board's key, with two members: Dev (the caller) and Peer.
	team, err := ts2.CreateTeam(ctx, &store.Team{Name: boardOf["alpha"], ConfigJSON: `{}`})
	require.NoError(t, err)
	agent := func(sid, name string) string {
		session := "claude-" + sid
		bk := boardOf["alpha"]
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: "/w", BoardName: &bk}))
		tok, err := srv.db.MintSessionToken(ctx, sid, session)
		require.NoError(t, err)
		_, err = bs.Subscribe(ctx, bk, name+"-"+sid[:4], name, session, nil, "all")
		require.NoError(t, err)
		_, err = ts2.CreateTeamMember(ctx, &store.TeamMember{TeamID: team.ID, AgentName: name, AgentConfigJSON: `{}`, SessionID: &sid})
		require.NoError(t, err)
		return tok
	}
	tokDev := agent("eeeeeeee-1148-4000-8000-00000000000a", "Dev")
	_ = agent("eeeeeeee-1148-4000-8000-00000000000b", "Peer")

	do := func(method, path, tok, body string) (int, map[string]any, string) {
		var rd io.Reader
		if body != "" {
			rd = bytes.NewBufferString(body)
		}
		req, _ := http.NewRequest(method, ts.URL+path, rd)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
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
	search := func(tok string, reach string) (int, map[string]any, string) {
		v := url.Values{"q": {"old decision"}}
		if reach != "" {
			v.Set("reach", reach)
		}
		return do("GET", "/api/agent/board/search?"+v.Encode(), tok, "")
	}
	setPath := "/api/teams/detail/" + url.PathEscape(team.Name) + "/members/Dev/search-access"
	set := func(level, confirm string) (int, map[string]any, string) {
		body := fmt.Sprintf(`{"level":%q`, level)
		if confirm != "" {
			body += fmt.Sprintf(`,"confirm":%q`, confirm)
		}
		return do("PUT", setPath, "", body+"}")
	}

	t.Run("every member starts at own, and the team detail says so", func(t *testing.T) {
		code, out, raw := do("GET", "/api/teams/detail/"+url.PathEscape(team.Name), "", "")
		require.Equal(t, http.StatusOK, code, raw)
		members, _ := out["members"].([]any)
		require.Len(t, members, 2)
		for _, m := range members {
			assert.Equal(t, "own", m.(map[string]any)["search_reach"])
		}
	})
	t.Run("at own a team, all or operator request is refused naming the level needed and where the Operator raises it, with no data", func(t *testing.T) {
		for _, reach := range []string{"team", "all", "operator"} {
			code, out, raw := search(tokDev, reach)
			assert.Equal(t, http.StatusForbidden, code, raw)
			assert.Equal(t, "search_reach_refused", out["code"])
			assert.Equal(t, "own", out["level"])
			assert.Equal(t, reach, out["requested"])
			assert.Equal(t, reach, out["needed"], "it names the level needed")
			assert.Contains(t, raw, "dashboard", "it says where the Operator raises it")
			assert.NotContains(t, raw, "CANARY")
		}
	})
	t.Run("an agent cannot raise its own level, nor its teammate's: the route is the Operator's", func(t *testing.T) {
		for _, tok := range []string{tokDev} {
			code, _, raw := do("PUT", setPath, tok, `{"level":"all","confirm":"operator"}`)
			assert.Equal(t, http.StatusForbidden, code, raw)
		}
		code, _, raw := do("PUT", "/api/teams/detail/"+url.PathEscape(team.Name)+"/members/Peer/search-access", tokDev, `{"level":"team"}`)
		assert.Equal(t, http.StatusForbidden, code, raw)
		_, out, _ := search(tokDev, "team")
		assert.Equal(t, "own", out["level"], "nothing changed")
	})
	t.Run("the Operator raises to team: the team's boards, not another team's", func(t *testing.T) {
		code, out, raw := set("team", "")
		require.Equal(t, http.StatusOK, code, raw)
		assert.Equal(t, "own", out["from"])
		assert.Equal(t, "team", out["level"])
		code, out, raw = search(tokDev, "team")
		require.Equal(t, http.StatusOK, code, raw)
		assert.Equal(t, "team", out["reach"])
		assert.Contains(t, raw, "CANARY-ALPHA")
		assert.NotContains(t, raw, "CANARY-BETA")
		assert.NotContains(t, raw, "CANARY-OPS")
		code, out, raw = search(tokDev, "all")
		assert.Equal(t, http.StatusForbidden, code, raw)
		assert.Equal(t, "team", out["level"])
		assert.Equal(t, "all", out["needed"])
		assert.NotContains(t, raw, "CANARY")
		code, _, raw = search(tokDev, "")
		require.Equal(t, http.StatusOK, code, raw)
		assert.Contains(t, raw, `"reach":"own"`, "no flag is own whatever the level")
	})
	t.Run("a step to operator needs the confirm, and an unknown level is a 400", func(t *testing.T) {
		code, out, raw := set("operator", "")
		assert.Equal(t, http.StatusBadRequest, code, raw)
		assert.Equal(t, "confirm_required", out["code"])
		code, _, _ = set("root", "")
		assert.Equal(t, http.StatusBadRequest, code)
		got, _ := ts2.SearchReachForSession(ctx, "eeeeeeee-1148-4000-8000-00000000000a")
		assert.Equal(t, "team", got, "a refused change leaves the level")
	})
	t.Run("all reads every board, the Operator's too; operator-history is a level above", func(t *testing.T) {
		code, _, raw := set("all", "")
		require.Equal(t, http.StatusOK, code, raw)
		code, _, raw = search(tokDev, "all")
		require.Equal(t, http.StatusOK, code, raw)
		for _, c := range []string{"CANARY-ALPHA", "CANARY-BETA", "CANARY-OPS"} {
			assert.Contains(t, raw, c)
		}
		code, out, raw := search(tokDev, "operator")
		assert.Equal(t, http.StatusForbidden, code, raw)
		assert.Equal(t, "operator", out["needed"])
		code, _, raw = set("operator", "operator")
		require.Equal(t, http.StatusOK, code, raw)
	})
	t.Run("a level follows the member through a restart, which gives it a new session id", func(t *testing.T) {
		tm, _ := ts2.GetMemberBySessionID(ctx, "eeeeeeee-1148-4000-8000-00000000000a")
		require.NotNil(t, tm)
		newSid := "eeeeeeee-1148-4000-8000-0000000000aa"
		require.NoError(t, ts2.UpdateMemberStatus(ctx, tm.ID, "active", &newSid))
		got, err := ts2.SearchReachForSession(ctx, newSid)
		require.NoError(t, err)
		assert.Equal(t, "operator", got)
	})
	t.Run("the access log has the raises and the reads above own, and no text", func(t *testing.T) {
		code, out, raw := do("GET", "/api/search-access/log", "", "")
		require.Equal(t, http.StatusOK, code, raw)
		rows, _ := out["rows"].([]any)
		kinds := map[string]int{}
		for _, r := range rows {
			kinds[r.(map[string]any)["kind"].(string)]++
		}
		assert.GreaterOrEqual(t, kinds["raise"], 3)
		assert.GreaterOrEqual(t, kinds["read"], 2)
		assert.NotContains(t, raw, "old decision", "no query text")
		assert.NotContains(t, raw, "CANARY", "no result text")
		code, _, _ = do("GET", "/api/search-access/log", tokDev, "")
		assert.Equal(t, http.StatusForbidden, code, "an agent cannot read the log")
	})
}

// Searches count against a per-member limit, refusals included, and a response is capped (#11048).
func TestSearchReachRateLimitCountsRefusals(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	ts2 := store.NewTeamStore(srv.db)
	bs := srv.boardStore
	b, err := bs.CreateBoard(ctx, "rl", "Operator")
	require.NoError(t, err)
	team, err := ts2.CreateTeam(ctx, &store.Team{Name: b.ID, ConfigJSON: `{}`})
	require.NoError(t, err)
	mk := func(sid string) string {
		bk := b.ID
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "Dev", WorkingDir: "/w", BoardName: &bk}))
		tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
		require.NoError(t, err)
		_, err = bs.Subscribe(ctx, bk, "Dev", "Dev", "claude-"+sid, nil, "all")
		require.NoError(t, err)
		return tok
	}
	sid1 := "eeeeeeee-1148-4000-8000-0000000000b1"
	tok1 := mk(sid1)
	_, err = ts2.CreateTeamMember(ctx, &store.TeamMember{TeamID: team.ID, AgentName: "Dev", AgentConfigJSON: `{}`, SessionID: &sid1})
	require.NoError(t, err)

	get := func(tok, q string) int {
		req, _ := http.NewRequest("GET", ts.URL+"/api/agent/board/search?"+q, nil)
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp.StatusCode
	}
	limited := false
	for i := 0; i < 200 && !limited; i++ {
		if get(tok1, "q=x&reach=all") == http.StatusTooManyRequests { // every one a refusal
			limited = true
		}
	}
	assert.True(t, limited, "refusals count: a loop of refused requests reaches the limit")

	// The limit is the member's, not the token's: a new token for the same member (a restart) is still limited.
	sid2 := "eeeeeeee-1148-4000-8000-0000000000b2"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid2, AgentType: "claude", AgentName: "Dev", WorkingDir: "/w", BoardName: &b.ID}))
	tm, _ := ts2.GetMemberBySessionID(ctx, sid1)
	require.NoError(t, ts2.UpdateMemberStatus(ctx, tm.ID, "active", &sid2))
	tok2, err := srv.db.MintSessionToken(ctx, sid2, "claude-"+sid2)
	require.NoError(t, err)
	assert.Equal(t, http.StatusTooManyRequests, get(tok2, "q=x"), "a fresh token does not reset the member's count")
}
