package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #11013 on the real router (Security Reviewer's probe): an agent's session token could POST /api/board/{any}/subscribe, because subscribe is exempt from the cross-board refusal (acrossBoards), and then read,
// post and see the tasks of ANY board, other teams' and the Operator's. An agent may join only the board it was launched on (its live row's board, its team row's board, or a board it already holds a seat on);
// the Operator's own join (the dashboard, the command line outside an agent) and the launch path are not an agent token and are unchanged.
func TestAgentTokenCannotSubscribeToAnotherBoard(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore

	do := func(method, path, body, tok string) (int, map[string]any) {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if tok != "" {
			req.Header.Set(store.SessionTokenHeader, tok)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return resp.StatusCode, out
	}
	subscribed := func(board, session string) bool {
		sub, err := bs.SessionSubscription(ctx, board, session)
		require.NoError(t, err)
		return sub != nil
	}
	join := func(board, name, session, tok string) (int, map[string]any) {
		b, _ := json.Marshal(map[string]string{"subscriber_id": name, "job_title": name, "session_name": session})
		return do("POST", "/api/board/"+board+"/subscribe", string(b), tok)
	}

	// Two teams' boards and the Operator's, each with a member and a message the others must not read.
	for _, b := range []string{"team-a", "team-b", "ops"} {
		_, err := bs.Subscribe(ctx, b, "Lead-"+b, "Lead", "", nil, "all")
		require.NoError(t, err)
		_, err = bs.PostMessage(ctx, b, "Lead-"+b, "private to "+b, nil)
		require.NoError(t, err)
	}
	teams := store.NewTeamStore(srv.db)
	teamA, err := teams.CreateTeam(ctx, &store.Team{Name: "team-a", ConfigJSON: "{}", WorkingDir: "/w"})
	require.NoError(t, err)

	// The agent: launched on team-a (the launch path subscribed it), its live row and team row say so.
	sid := "aaaaaaaa-1101-4000-8000-000000000001"
	name := "claude-" + sid
	boardA := "team-a"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &boardA}))
	require.NoError(t, ss.SetTeamID(ctx, sid, teamA.ID))
	tok, err := srv.db.MintSessionToken(ctx, sid, name)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "team-a", "Dev", "Dev", name, nil, "all")
	require.NoError(t, err)

	t.Run("another team's board and the Operator's are refused, and nothing is read", func(t *testing.T) {
		for _, foreign := range []string{"team-b", "ops"} {
			code, out := join(foreign, "Dev", name, tok)
			assert.Equal(t, http.StatusForbidden, code, "%s: %v", foreign, out)
			assert.Equal(t, "identity_mismatch", out["code"], foreign)
			assert.False(t, subscribed(foreign, name), "%s: no seat was made", foreign)
			code, _ = do("GET", "/api/board/"+foreign+"/messages/all", "", tok)
			assert.Equal(t, http.StatusForbidden, code, "%s: its messages are not readable", foreign)
		}
	})
	t.Run("a post with an 'as' does not subscribe it either", func(t *testing.T) {
		code, _ := do("POST", "/api/board/team-b/messages", `{"subscriber_id":"Dev","as":"Dev","content":"hi"}`, tok)
		assert.Equal(t, http.StatusForbidden, code)
		assert.False(t, subscribed("team-b", name))
	})
	t.Run("its own launch board still works: a seat it holds, and one it has lost", func(t *testing.T) {
		code, out := join("team-a", "Dev", name, tok)
		assert.Equal(t, http.StatusOK, code, "re-joining the board it is on (a restart's join): %v", out)
		_, err := bs.Unsubscribe(ctx, "team-a", "Dev")
		require.NoError(t, err)
		code, out = join("team-a", "Dev", name, tok)
		assert.Equal(t, http.StatusOK, code, "its live row names team-a: the seat is made again: %v", out)
		assert.True(t, subscribed("team-a", name))
	})
	t.Run("a team row alone does not admit a join: it records no board key, only a name that two boards can share", func(t *testing.T) {
		sid2 := "aaaaaaaa-1101-4000-8000-000000000002"
		name2 := "claude-" + sid2
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid2, AgentType: "claude", AgentName: "dev2", WorkingDir: "/w"}))
		require.NoError(t, ss.SetTeamID(ctx, sid2, teamA.ID))
		tok2, err := srv.db.MintSessionToken(ctx, sid2, name2)
		require.NoError(t, err)
		for _, board := range []string{"team-a", "team-b"} {
			code, out := join(board, "Dev2", name2, tok2)
			assert.Equal(t, http.StatusForbidden, code, "%s: %v", board, out)
		}
	})
	t.Run("a session whose only link to the board is the board its live row was launched on may join it", func(t *testing.T) {
		sid4 := "aaaaaaaa-1101-4000-8000-000000000004"
		name4 := "claude-" + sid4
		launched := "team-a"
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid4, AgentType: "claude", AgentName: "dev4", WorkingDir: "/w", BoardName: &launched}))
		tok4, err := srv.db.MintSessionToken(ctx, sid4, name4)
		require.NoError(t, err)
		code, out := join("team-b", "Dev4", name4, tok4)
		assert.Equal(t, http.StatusForbidden, code, "not another board: %v", out)
		code, out = join("team-a", "Dev4", name4, tok4)
		assert.Equal(t, http.StatusOK, code, "%v", out)
	})
	t.Run("a seat it already holds on a board is rejoinable without a launch record naming it", func(t *testing.T) {
		sid5 := "aaaaaaaa-1101-4000-8000-000000000005"
		name5 := "claude-" + sid5
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid5, AgentType: "claude", AgentName: "dev5", WorkingDir: "/w"}))
		tok5, err := srv.db.MintSessionToken(ctx, sid5, name5)
		require.NoError(t, err)
		_, err = bs.Subscribe(ctx, "team-b", "Dev5", "Dev5", name5, nil, "all") // the launch path's own seat (server side), whatever the row says
		require.NoError(t, err)
		code, out := join("team-b", "Dev5", name5, tok5)
		assert.Equal(t, http.StatusOK, code, "%v", out)
	})
	t.Run("a session with no board and no team joins nothing", func(t *testing.T) {
		sid3 := "aaaaaaaa-1101-4000-8000-000000000003"
		name3 := "claude-" + sid3
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid3, AgentType: "claude", AgentName: "solo", WorkingDir: "/w"}))
		tok3, err := srv.db.MintSessionToken(ctx, sid3, name3)
		require.NoError(t, err)
		code, out := join("team-a", "Solo", name3, tok3)
		assert.Equal(t, http.StatusForbidden, code, "%v", out)
		assert.False(t, subscribed("team-a", name3))
	})
	t.Run("the Operator's join, with no agent token, is unchanged", func(t *testing.T) {
		code, out := join("team-b", "Helper", "claude-aaaaaaaa-1101-4000-8000-000000000009", "")
		assert.Equal(t, http.StatusOK, code, "the dashboard or the command line outside an agent: %v", out)
	})
}

// #11013, Security's MUST on round 1: the launch route is the same door with a launch in front. POST /api/sessions/launch (and launch-team) is agent-reachable, and its only gate for the board was
// "an agent may launch onto a board its OWNER owns" (mayLaunchOnto), which is every board on a one-operator Coral: the new session is seated on that board by the server's launch path, with its own token.
// For an agent token the board must be the agent's own (its live row's board, recorded when it was launched).
func TestAgentTokenCannotLaunchOntoAnotherBoard(t *testing.T) {
	srv, ts, dir := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	a, err := bs.CreateBoard(ctx, "team-a", "Operator")
	require.NoError(t, err)
	b, err := bs.CreateBoard(ctx, "team-b", "Operator")
	require.NoError(t, err)
	ops, err := bs.CreateBoard(ctx, "ops", "Operator")
	require.NoError(t, err)
	sid := "bbbbbbbb-1101-4000-8000-000000000001"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &a.ID}))
	tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, a.ID, "Dev", "Orchestrator", "claude-"+sid, nil, "all")
	require.NoError(t, err)
	work := strictWorkDir(t, dir)
	liveCount := func() int {
		all, err := ss.GetAllLiveSessions(ctx)
		require.NoError(t, err)
		return len(all)
	}
	post := func(path string, body map[string]any, token string) (int, map[string]any) {
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", ts.URL+path, strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set(store.SessionTokenHeader, token)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return resp.StatusCode, out
	}
	launch := func(board string, token string) (int, map[string]any) {
		return post("/api/sessions/launch", map[string]any{"working_dir": work, "agent_type": "terminal", "board_id": board, "display_name": "helper"}, token)
	}

	t.Run("another team's board and the Operator's are refused, and nothing is started", func(t *testing.T) {
		before := liveCount()
		for _, foreign := range []string{b.ID, ops.ID} {
			code, out := launch(foreign, tok)
			assert.Equal(t, http.StatusForbidden, code, "%s: %v", foreign, out)
			assert.Equal(t, "forbidden_for_agent", out["code"], foreign)
		}
		assert.Equal(t, before, liveCount(), "no session was made")
		subs, err := bs.ListSubscribers(ctx, b.ID)
		require.NoError(t, err)
		for _, s := range subs {
			assert.NotEqual(t, "helper", s.JobTitle, "no seat on team-b")
		}
	})
	t.Run("a team launch onto another board is refused the same way", func(t *testing.T) {
		code, out := post("/api/sessions/launch-team", map[string]any{"working_dir": work, "agent_type": "terminal", "board_id": b.ID,
			"agents": []map[string]any{{"name": "helper", "role": "Dev"}}}, tok)
		assert.Equal(t, http.StatusForbidden, code, "%v", out)
		assert.Contains(t, out["message"], "its own team's board", "refused by the board gate, not by something else: %v", out)
	})
	t.Run("its own board still works", func(t *testing.T) {
		code, out := launch(a.ID, tok)
		assert.Equal(t, http.StatusOK, code, "an agent starts agents on its own team: %v", out)
		assert.Equal(t, a.ID, out["board_id"])
	})
	t.Run("an agent with no recorded board starts agents on no existing board", func(t *testing.T) {
		sid2 := "bbbbbbbb-1101-4000-8000-000000000002"
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid2, AgentType: "claude", AgentName: "solo", WorkingDir: "/w"}))
		tok2, err := srv.db.MintSessionToken(ctx, sid2, "claude-"+sid2)
		require.NoError(t, err)
		code, out := launch(a.ID, tok2)
		assert.Equal(t, http.StatusForbidden, code, "%v", out)
	})
	t.Run("the Operator's launch onto any board is unchanged", func(t *testing.T) {
		code, out := launch(b.ID, "")
		assert.Equal(t, http.StatusOK, code, "%v", out)
	})
}

// Security's SHOULD (c): the join variants a path-matching gate could miss. A trailing slash, a doubled slash, another case and an escaped letter in 'subscribe' are never an admitted join on a board the
// agent was not launched on, whatever the router makes of them.
func TestAgentTokenJoinVariantsAreNeverAdmitted(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	for _, b := range []string{"team-a", "team-b"} {
		_, err := bs.Subscribe(ctx, b, "Lead-"+b, "Lead", "", nil, "all")
		require.NoError(t, err)
	}
	sid := "cccccccc-1101-4000-8000-000000000001"
	name := "claude-" + sid
	boardA := "team-a"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &boardA}))
	tok, err := srv.db.MintSessionToken(ctx, sid, name)
	require.NoError(t, err)
	for _, path := range []string{"/api/board/team-b/subscribe", "/api/board/team-b/subscribe/", "/api/board//team-b/subscribe", "/api/board/team-b//subscribe",
		"/api/board/team-b/Subscribe", "/api/board/team-b/SUBSCRIBE", "/api/board/team-b/%73ubscribe", "/api/board/%74eam-b/subscribe", "/api/board/team-b/subscribe?x=1", "/api/board/TEAM-B/subscribe"} {
		req, _ := http.NewRequest("POST", ts.URL+path, strings.NewReader(`{"subscriber_id":"Dev","job_title":"Dev","session_name":"`+name+`"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err, path)
		resp.Body.Close()
		assert.NotEqual(t, http.StatusOK, resp.StatusCode, "%s must not be a join", path)
		sub, err := bs.SessionSubscription(ctx, "team-b", name)
		require.NoError(t, err)
		assert.Nil(t, sub, "%s: no seat on team-b", path)
	}
}

// #11013, Security's round 2: the 409 answers that list boards (board_name_exists on a launch, ambiguous_board on a shared label) described every matching board to ANY authenticated caller: its id, label, created time and
// member count, and for a launch how many of its agents are live. For an agent token that is another team's board id and size, handed to it by guessing a name. An agent is told only about boards it holds a seat on.
func TestAgentTokenIsNotListedOtherTeamsBoardsInA409(t *testing.T) {
	srv, ts, dir := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	a, err := bs.CreateBoard(ctx, "team-a", "Operator")
	require.NoError(t, err)
	b, err := bs.CreateBoard(ctx, "team-b", "Operator")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, b.ID, "Secret Member", "Secret Role", "", nil, "all")
	require.NoError(t, err)
	// Two boards share the label "shared": one is the agent's own, one another team's.
	s1, err := bs.CreateBoard(ctx, "shared", "Operator")
	require.NoError(t, err)
	s2, err := bs.CreateBoard(ctx, "shared", "Operator")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, s2.ID, "Other Roster", "Other Role", "", nil, "all")
	require.NoError(t, err)
	sid := "dddddddd-1101-4000-8000-000000000001"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &s1.ID}))
	tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, s1.ID, "Dev", "Orchestrator", "claude-"+sid, nil, "all")
	require.NoError(t, err)
	work := strictWorkDir(t, dir)
	_ = a

	call := func(method, path, body, token string) (int, string, map[string]any) {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set(store.SessionTokenHeader, token)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, string(raw), out
	}
	launchBody := func(name string) string {
		raw, _ := json.Marshal(map[string]any{"working_dir": work, "agent_type": "terminal", "board_name": name, "display_name": "helper"})
		return string(raw)
	}

	t.Run("a launch by another team's board name says the name is taken and describes nothing", func(t *testing.T) {
		code, raw, out := call("POST", "/api/sessions/launch", launchBody("team-b"), tok)
		assert.Equal(t, http.StatusConflict, code, raw)
		assert.Equal(t, "board_name_exists", out["code"], raw)
		for _, secret := range []string{b.ID, "Secret Member", "Secret Role", "live_agents"} {
			assert.NotContains(t, raw, secret, "another team's board is not described to an agent")
		}
	})
	t.Run("a shared label names the agent's own board and no other", func(t *testing.T) {
		code, raw, out := call("POST", "/api/board/shared/external-messages", `{}`, tok) // a route an agent may reach on a board it is not on: the label resolves before the handler
		assert.Equal(t, http.StatusConflict, code, raw)
		assert.Equal(t, "ambiguous_board", out["code"], raw)
		assert.Contains(t, raw, s1.ID, "its own board is listed")
		for _, secret := range []string{s2.ID, "Other Roster", "Other Role"} {
			assert.NotContains(t, raw, secret, "the other team's board with that label is not")
		}
	})
	t.Run("a seat the Operator made on another board does not list it: the agent's board is its live row's", func(t *testing.T) {
		_, err := bs.Subscribe(ctx, b.ID, "Dev-seated", "Dev", "claude-"+sid, nil, "all") // the Operator seats this session on team-b
		require.NoError(t, err)
		_, err = bs.Subscribe(ctx, s2.ID, "Dev-seated", "Dev", "claude-"+sid, nil, "all") // and on the other board labelled "shared"
		require.NoError(t, err)
		code, raw, _ := call("POST", "/api/sessions/launch", launchBody("team-b"), tok)
		assert.Equal(t, http.StatusConflict, code, raw)
		assert.NotContains(t, raw, b.ID, "its seat on team-b does not make team-b its board")
		code, raw, _ = call("POST", "/api/board/shared/external-messages", `{}`, tok)
		assert.Equal(t, http.StatusConflict, code, raw)
		assert.Contains(t, raw, s1.ID, "its own board")
		assert.NotContains(t, raw, s2.ID, "its seat on the other board with that label does not list it")
	})
	t.Run("the Operator still sees every candidate", func(t *testing.T) {
		code, raw, _ := call("POST", "/api/sessions/launch", launchBody("team-b"), "")
		assert.Equal(t, http.StatusConflict, code, raw)
		assert.Contains(t, raw, b.ID)
		assert.Contains(t, raw, "live_agents")
		code, raw, _ = call("POST", "/api/board/shared/external-messages", `{}`, "")
		assert.Equal(t, http.StatusConflict, code, raw)
		assert.Contains(t, raw, s1.ID)
		assert.Contains(t, raw, s2.ID)
	})
}
