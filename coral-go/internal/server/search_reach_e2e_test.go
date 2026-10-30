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

	ptrTo := func(v string) *string { return &v }
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
	// Two teams NAMED by labels (never by their boards' keys), each with a member whose live row says its launch board and team. Around them: a legacy board whose KEY is team alpha's name and belongs to nobody
	// (the trap: a team's name is not a board key), a job's board and a relayed (remote) board, which no level reaches, and the Operator's own board, which only 'operator' does.
	const alphaName = "alpha-team-label"
	team, err := ts2.CreateTeam(ctx, &store.Team{Name: alphaName, ConfigJSON: `{}`})
	require.NoError(t, err)
	teamB, err := ts2.CreateTeam(ctx, &store.Team{Name: "beta-team-label", ConfigJSON: `{}`})
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, alphaName, "Squatter", "Member", "", nil, "all") // a board whose key is the word alpha-team-label
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, alphaName, "Squatter", "CANARY-TRAP the old decision", nil)
	require.NoError(t, err)
	for _, n := range []string{"job", "relay"} {
		b, err := bs.CreateBoard(ctx, n, "Operator")
		require.NoError(t, err)
		boardOf[n] = b.ID
		_, err = bs.Subscribe(ctx, b.ID, "Lead-"+n, "Lead", "", nil, "all")
		require.NoError(t, err)
		_, err = bs.PostMessage(ctx, b.ID, "Lead-"+n, "CANARY-"+strings.ToUpper(n)+" the old decision", nil)
		require.NoError(t, err)
	}
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "eeeeeeee-1148-4000-8000-0000000000c1", AgentType: "claude", AgentName: "nightly", WorkingDir: "/w", BoardName: ptrTo(boardOf["job"]), IsJob: 1}))
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "eeeeeeee-1148-4000-8000-0000000000c2", AgentType: "claude", AgentName: "remote", WorkingDir: "/w", BoardName: ptrTo(boardOf["relay"]), BoardServer: ptrTo("https://other.example")}))
	// Two boards whose jobs are FINISHED (no live row any more): one a past run's, found by the backfill from the runs table; one a job's agent used through the API, marked the moment it was used (#11076).
	for _, n := range []string{"finished", "srcmark"} {
		b, err := bs.CreateBoard(ctx, n, "Operator")
		require.NoError(t, err)
		boardOf[n] = b.ID
		_, err = bs.Subscribe(ctx, b.ID, "Lead-"+n, "Lead", "", nil, "all")
		require.NoError(t, err)
		_, err = bs.PostMessage(ctx, b.ID, "Lead-"+n, "CANARY-"+strings.ToUpper(n)+" the old decision", nil)
		require.NoError(t, err)
	}
	const finishedSid, markSid = "eeeeeeee-1148-4000-8000-0000000000d1", "eeeeeeee-1148-4000-8000-0000000000d2"
	_, err = bs.Subscribe(ctx, boardOf["finished"], "Nightly", "Nightly", "claude-"+finishedSid, nil, "all") // its run ended: a runs row, a member name, no live row
	require.NoError(t, err)
	_, err = srv.db.ExecContext(ctx, `INSERT INTO scheduled_jobs (name, cron_expr, repo_path, prompt, enabled, created_at, updated_at) VALUES ('nightly', '0 3 * * *', '/w', 'p', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
	require.NoError(t, err)
	_, err = srv.db.ExecContext(ctx, `INSERT INTO scheduled_runs (job_id, session_id, status, scheduled_at, created_at) VALUES ((SELECT id FROM scheduled_jobs LIMIT 1), ?, 'completed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, finishedSid)
	require.NoError(t, err)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: markSid, AgentType: "claude", AgentName: "job2", WorkingDir: "/w", BoardName: ptrTo(boardOf["srcmark"]), IsJob: 1}))
	markTok, err := srv.db.MintSessionToken(ctx, markSid, "claude-"+markSid)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, boardOf["srcmark"], "Job2", "Job2", "claude-"+markSid, nil, "all")
	require.NoError(t, err)
	agentOn := func(tm *store.Team, board, sid, name string) string {
		session := "claude-" + sid
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: "/w", BoardName: &board}))
		require.NoError(t, ss.SetTeamID(ctx, sid, tm.ID))
		tok, err := srv.db.MintSessionToken(ctx, sid, session)
		require.NoError(t, err)
		_, err = bs.Subscribe(ctx, board, name+"-"+sid[:4], name, session, nil, "all")
		require.NoError(t, err)
		_, err = ts2.CreateTeamMember(ctx, &store.TeamMember{TeamID: tm.ID, AgentName: name, AgentConfigJSON: `{}`, SessionID: &sid})
		require.NoError(t, err)
		return tok
	}
	tokDev := agentOn(team, boardOf["alpha"], "eeeeeeee-1148-4000-8000-00000000000a", "Dev")
	_ = agentOn(team, boardOf["alpha"], "eeeeeeee-1148-4000-8000-00000000000b", "Peer")
	_ = agentOn(teamB, boardOf["beta"], "eeeeeeee-1148-4000-8000-0000000000b0", "Beta")

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
	devM, _ := ts2.GetMemberBySessionID(ctx, "eeeeeeee-1148-4000-8000-00000000000a")
	peerM, _ := ts2.GetMemberBySessionID(ctx, "eeeeeeee-1148-4000-8000-00000000000b")
	require.NotNil(t, devM)
	require.NotNil(t, peerM)
	setPath := fmt.Sprintf("/api/team-members/%d/search-access", devM.ID)
	set := func(level, confirm string) (int, map[string]any, string) {
		body := fmt.Sprintf(`{"level":%q`, level)
		if confirm != "" {
			body += fmt.Sprintf(`,"confirm":%q`, confirm)
		}
		return do("PUT", setPath, "", body+"}")
	}

	// The job's agent uses its board (a post), which marks the board as a job's; then its run ends.
	code, _, raw0 := do("POST", "/api/board/"+boardOf["srcmark"]+"/messages", markTok, `{"subscriber_id":"Job2","content":"job note"}`)
	require.Equal(t, http.StatusOK, code, raw0)
	_, err = srv.db.ExecContext(ctx, `DELETE FROM live_sessions WHERE session_id = ?`, markSid)
	require.NoError(t, err)
	_, err = srv.boardStore.BackfillJobBoards(ctx)
	require.NoError(t, err)

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
		code, _, raw := do("PUT", fmt.Sprintf("/api/team-members/%d/search-access", peerM.ID), tokDev, `{"level":"team"}`)
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
		for _, c := range []string{"CANARY-BETA", "CANARY-OPS", "CANARY-TRAP", "CANARY-JOB", "CANARY-RELAY"} {
			assert.NotContains(t, raw, c, "team: the boards its members were launched on, by key: not %s (a board whose key is the team's NAME is not its board)", c)
		}
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
	t.Run("all reads the boards of teams Coral launched; operator adds the boards no team owns; a job's and a relayed board are never read", func(t *testing.T) {
		code, _, raw := set("all", "")
		require.Equal(t, http.StatusOK, code, raw)
		code, _, raw = search(tokDev, "all")
		require.Equal(t, http.StatusOK, code, raw)
		for _, c := range []string{"CANARY-ALPHA", "CANARY-BETA"} {
			assert.Contains(t, raw, c)
		}
		for _, c := range []string{"CANARY-OPS", "CANARY-TRAP", "CANARY-JOB", "CANARY-RELAY", "CANARY-FINISHED", "CANARY-SRCMARK"} {
			assert.NotContains(t, raw, c, "all: team-launched boards only, not %s", c)
		}
		code, out, raw := search(tokDev, "operator")
		assert.Equal(t, http.StatusForbidden, code, raw)
		assert.Equal(t, "operator", out["needed"])
		code, _, raw = set("operator", "operator")
		require.Equal(t, http.StatusOK, code, raw)
		code, _, raw = search(tokDev, "operator")
		require.Equal(t, http.StatusOK, code, raw)
		for _, c := range []string{"CANARY-ALPHA", "CANARY-BETA", "CANARY-OPS", "CANARY-TRAP"} {
			assert.Contains(t, raw, c, "operator adds the boards with no team row")
		}
		for _, c := range []string{"CANARY-JOB", "CANARY-RELAY", "CANARY-FINISHED", "CANARY-SRCMARK"} {
			assert.NotContains(t, raw, c, "a job's board (a finished run's too) and a relayed board are out at every level")
		}
	})
	t.Run("a member id that is not there is a 404, and the level is read from the caller's row, never from a name", func(t *testing.T) {
		code, _, raw := do("PUT", "/api/team-members/999999/search-access", "", `{"level":"team"}`)
		assert.Equal(t, http.StatusNotFound, code, raw)
		code, _, _ = do("PUT", "/api/team-members/abc/search-access", "", `{"level":"team"}`)
		assert.Equal(t, http.StatusBadRequest, code)
		got, _ := ts2.SearchReachForSession(ctx, "eeeeeeee-1148-4000-8000-00000000000b")
		assert.Equal(t, "own", got, "the teammate's level is its own row's")
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
		sawTarget := false
		for _, r := range rows {
			m := r.(map[string]any)
			if m["kind"] == "read" && m["outcome"] == "ok" && m["action"] == "board-search" && strings.Contains(fmt.Sprint(m["target"]), boardOf["alpha"]) {
				sawTarget = true
			}
		}
		assert.True(t, sawTarget, "a read says what it was and which boards it touched, by key")
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
		require.NoError(t, ss.SetTeamID(ctx, sid, team.ID))
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
	assert.Equal(t, http.StatusOK, get(tok1, "q=x"), "a read at own is the agent's own and is not limited")

	// The limit is the member's, not the token's: a new token for the same member (a restart) is still limited.
	sid2 := "eeeeeeee-1148-4000-8000-0000000000b2"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid2, AgentType: "claude", AgentName: "Dev", WorkingDir: "/w", BoardName: &b.ID}))
	require.NoError(t, ss.SetTeamID(ctx, sid2, team.ID))
	tm, _ := ts2.GetMemberBySessionID(ctx, sid1)
	require.NoError(t, ts2.UpdateMemberStatus(ctx, tm.ID, "active", &sid2))
	tok2, err := srv.db.MintSessionToken(ctx, sid2, "claude-"+sid2)
	require.NoError(t, err)
	assert.Equal(t, http.StatusTooManyRequests, get(tok2, "q=x&reach=all"), "a fresh token does not reset the member's count")
}
