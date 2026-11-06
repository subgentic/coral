package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13891: the Orchestrator of a team the Operator describes can launch its helpers with no visit to the settings: a NEW team the Operator launches starts with the grant ON, its Orchestrator the seat,
// five helpers at a time besides it (Security's design verdict). Written at creation only, by the Operator's own launch, insert-if-absent. An agent's launch in a team's folder only.

func defTeamBody(boardName, dir string, names ...string) string {
	agents := make([]map[string]any, len(names))
	for i, n := range names {
		agents[i] = map[string]any{"name": n, "prompt": "work"}
	}
	b, _ := json.Marshal(map[string]any{"board_name": boardName, "new_board": true, "working_dir": dir, "agent_type": "claude", "agents": agents})
	return string(b)
}

func defMemberSession(t *testing.T, out map[string]any, name string) (sid, sessionName string) {
	t.Helper()
	for _, a := range out["agents"].([]any) {
		m := a.(map[string]any)
		if m["name"] == name {
			sid, _ = m["session_id"].(string)
			sessionName, _ = m["session_name"].(string)
			return sid, sessionName
		}
	}
	t.Fatalf("no member %q in %v", name, out)
	return "", ""
}

func defMemberSID(t *testing.T, out map[string]any, name string) string {
	t.Helper()
	sid, _ := defMemberSession(t, out, name)
	return sid
}

func TestATeamTheOperatorLaunchesStartsWithTheGrantOnForItsOrchestrator(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	code, out := r.do("POST", "/api/sessions/launch-team", defTeamBody("fresh", r.work, "Orchestrator", "Dev"), operatorClient, "")
	require.Equal(t, http.StatusOK, code, out)
	seat := defMemberSID(t, out, "Orchestrator")
	require.NotEmpty(t, seat)
	bid, _ := out["board_id"].(string)
	require.NotEmpty(t, bid)
	g, err := r.h.bs.GetOrchGrant(ctx, bid)
	require.NoError(t, err)
	assert.True(t, g.Enabled, "the switch starts on")
	assert.Equal(t, seat, g.SeatSession, "the Orchestrator the launch started is the seat")
	assert.Equal(t, board.TeamLaunchOrchMaxLive, g.MaxLive)
	assert.Equal(t, 5, g.MaxLive)
	assert.Equal(t, board.DefaultOrchMaxPerHour, g.MaxPerHour)
	assert.Equal(t, board.TeamLaunchSetBy, g.SetBy)
	// it is said on the board and in the log, as a change the Operator makes is
	log, err := r.h.bs.LifecycleLog(ctx, bid, 20)
	require.NoError(t, err)
	var grants int
	for _, e := range log {
		if e.Kind == "grant" {
			grants++
		}
	}
	assert.Equal(t, 1, grants, "the grant is in the log")
	msgs, _ := r.h.bs.ListMessages(ctx, bid, 50, 0, 0)
	said := false
	for _, m := range msgs {
		if m.SubscriberID == "Coral" && strings.Contains(m.Content, "Orchestrator may start") {
			said = true
		}
	}
	assert.True(t, said, "the board says what the Orchestrator may do")
}

func TestATeamWithoutAnOrchestratorGetsNoGrant(t *testing.T) {
	r := newOrchRig(t)
	code, out := r.do("POST", "/api/sessions/launch-team", defTeamBody("plain", r.work, "Dev", "Dev2"), operatorClient, "")
	require.Equal(t, http.StatusOK, code, out)
	g, err := r.h.bs.GetOrchGrant(context.Background(), out["board_id"].(string))
	require.NoError(t, err)
	assert.False(t, g.Enabled)
	assert.Empty(t, g.SeatSession)
}

// Security's MUST 1: an agent's launch-team never writes the grant, whatever it names its member.
func TestATeamAnAgentLaunchesGetsNoGrant(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	code, out := r.do("POST", "/api/sessions/launch-team", defTeamBody("agentmade", r.work, "Orchestrator", "Dev3"), nil, r.tok["Dev2"])
	require.Equal(t, http.StatusOK, code, out)
	g, err := r.h.bs.GetOrchGrant(context.Background(), out["board_id"].(string))
	require.NoError(t, err)
	assert.False(t, g.Enabled, "a team an agent makes does not start with a grant")
	assert.Empty(t, g.SeatSession)
}

// Security's MUST 2: insert only if absent. An existing row, off included, and a relaunch of an existing team stand.
func TestTheSeededGrantNeverOverwritesOrReachesAnExistingTeam(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	// a board the Operator already set up with the switch off and its own caps
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"max_live": 7})
	require.Equal(t, http.StatusOK, code)
	code, _ = r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", `{"enabled":false,"max_live":7,"max_per_hour":3,"idle_minutes":9}`, operatorClient, "")
	require.Equal(t, http.StatusOK, code)
	wrote, err := r.h.bs.SeedOrchGrant(ctx, orchBoard, "some-other-session")
	require.NoError(t, err)
	assert.False(t, wrote, "an existing row is never written over")
	g, _ := r.h.bs.GetOrchGrant(ctx, orchBoard)
	assert.False(t, g.Enabled, "off stays off")
	assert.Equal(t, 7, g.MaxLive)
	assert.Equal(t, 3, g.MaxPerHour)
	// a relaunch of a team that has a board and no row does not turn anything on
	code, out := r.do("POST", "/api/sessions/launch-team", defTeamBody("oldteam", r.work, "Dev9"), operatorClient, "")
	require.Equal(t, http.StatusOK, code, out)
	oldID := out["board_id"].(string)
	b, _ := json.Marshal(map[string]any{"board_id": oldID, "working_dir": r.work, "agent_type": "claude", "agents": []map[string]any{{"name": "Orchestrator2", "prompt": "work"}}})
	code, out = r.do("POST", "/api/sessions/launch-team", string(b), operatorClient, "")
	require.Equal(t, http.StatusOK, code, out)
	g, _ = r.h.bs.GetOrchGrant(ctx, oldID)
	assert.False(t, g.Enabled, "a team that already had a board keeps today's behaviour")
	assert.Empty(t, g.SeatSession)
}

// The first-run walk: the Operator describes a team, its Orchestrator starts five helpers with no settings visit, and the sixth is refused with who can raise it.
func TestTheOrchestratorOfANewTeamStartsFiveHelpersAndTheSixthIsRefused(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	code, out := r.do("POST", "/api/sessions/launch-team", defTeamBody("walk", r.work, "Orchestrator"), operatorClient, "")
	require.Equal(t, http.StatusOK, code, out)
	walkID, _ := out["board_id"].(string)
	seatSID, seatName := defMemberSession(t, out, "Orchestrator")
	require.NotEmpty(t, seatSID)
	r.sid["Orchestrator"] = seatSID
	r.tok["Orchestrator"] = agentToken(t, r.h, seatSID, seatName)
	launch := func(n string) (int, map[string]any) {
		b, _ := json.Marshal(map[string]any{"working_dir": r.work, "agent_type": "claude", "board_id": walkID, "display_name": n})
		return r.do("POST", "/api/sessions/launch", string(b), nil, r.tok["Orchestrator"])
	}
	for _, n := range []string{"H1", "H2", "H3", "H4", "H5"} {
		code, out := launch(n)
		require.Equal(t, http.StatusOK, code, "%s: %v", n, out)
	}
	code, out = launch("H6")
	assert.Equal(t, http.StatusTooManyRequests, code, out)
	assert.Equal(t, "board_live_limit", out["code"])
	assert.Contains(t, out["error"], "5 live agents")
	assert.Contains(t, out["error"], "Operator")
	assert.Contains(t, out["error"], "team's settings")
	live, _ := r.ss.CountActiveLiveSessions(ctx)
	assert.Equal(t, 6, live, "the seat and five helpers")
}

// Security's MUST 3: an agent's launch onto a board stays in the team's folder, symlinks resolved; the Operator's does not.
func TestAnAgentsLaunchStaysInTheTeamsFolder(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", nil) // the rule is for a board whose grant is on
	require.Equal(t, http.StatusOK, code)
	outside := t.TempDir()
	inside := filepath.Join(r.work, "sub")
	require.NoError(t, os.MkdirAll(inside, 0o755))
	link := filepath.Join(r.work, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("no symlinks here:", err)
	}
	launch := func(dir string, client *http.Client, tok string) (int, map[string]any) {
		b, _ := json.Marshal(map[string]any{"working_dir": dir, "agent_type": "claude", "board_id": orchBoard, "display_name": "Helper"})
		return r.do("POST", "/api/sessions/launch", string(b), client, tok)
	}
	code, out := launch(inside, nil, r.tok["Dev2"])
	assert.Equal(t, http.StatusOK, code, "a folder below the team's: %v", out)
	code, out = launch(outside, nil, r.tok["Dev2"])
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.Equal(t, "outside_team_folder", out["code"])
	code, out = launch(link, nil, r.tok["Dev2"])
	assert.Equal(t, http.StatusForbidden, code, "a link out of the folder does not count: %v", out)
	assert.Equal(t, "outside_team_folder", out["code"])
	code, out = launch("relative/dir", nil, r.tok["Dev2"])
	assert.Equal(t, http.StatusForbidden, code, out)
	// and a team launch by an agent is held the same way
	b, _ := json.Marshal(map[string]any{"board_id": orchBoard, "working_dir": outside, "agent_type": "claude", "agents": []map[string]any{{"name": "T1", "prompt": "work"}}})
	code, out = r.do("POST", "/api/sessions/launch-team", string(b), nil, r.tok["Dev2"])
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.Equal(t, "outside_team_folder", out["code"])
	// the Operator picks any folder
	code, out = launch(outside, operatorClient, "")
	assert.Equal(t, http.StatusOK, code, "the Operator is not held to the team's folder: %v", out)
}

// The upgrade rule: a board with no grant row, or a grant that is off, keeps what it had. An agent starts agents in any folder there.
func TestTheFolderRuleDoesNotApplyWhereTheGrantIsOffOrAbsent(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard() // no grant row
	// a launched helper's folder becomes one of the team's, so each step names a folder of its own
	launch := func(dir string) (int, map[string]any) {
		b, _ := json.Marshal(map[string]any{"working_dir": dir, "agent_type": "claude", "board_id": orchBoard, "display_name": "Helper"})
		return r.do("POST", "/api/sessions/launch", string(b), nil, r.tok["Dev2"])
	}
	code, out := launch(t.TempDir())
	assert.Equal(t, http.StatusOK, code, "no row: today's behaviour: %v", out)
	code, _ = r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	code, out = launch(t.TempDir())
	assert.Equal(t, http.StatusForbidden, code, "on: held to the team's folder: %v", out)
	code, _ = r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", `{"enabled":false,"max_live":8,"max_per_hour":10,"idle_minutes":5}`, operatorClient, "")
	require.Equal(t, http.StatusOK, code)
	code, out = launch(t.TempDir())
	assert.Equal(t, http.StatusOK, code, "off again: today's behaviour: %v", out)
}

// A session's repo and its worktree folder are the team's: a helper in a sibling worktree of the team's repo is accepted, a folder outside the repo is not.
func TestASiblingWorktreeOfTheTeamsRepoIsTheTeamsFolder(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	repo := t.TempDir()
	wt := filepath.Join(repo, ".worktrees", "dev3")
	sibling := filepath.Join(repo, ".worktrees", "dev4")
	require.NoError(t, os.MkdirAll(wt, 0o755))
	require.NoError(t, os.MkdirAll(sibling, 0o755))
	r.usualBoard()
	// Dev3 works in a worktree of the repo, recorded as a team launch records it
	sid := r.seat("Dev3", "Developer", orchBoard, "claude", false, 4)
	require.NoError(t, r.ss.UpdateWorktreeInfo(ctx, sid, wt, repo))
	_, err := r.h.db.ExecContext(ctx, `UPDATE live_sessions SET working_dir = ? WHERE session_id = ?`, wt, sid)
	require.NoError(t, err)
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	launch := func(dir string) (int, map[string]any) {
		b, _ := json.Marshal(map[string]any{"working_dir": dir, "agent_type": "claude", "board_id": orchBoard, "display_name": "Helper"})
		return r.do("POST", "/api/sessions/launch", string(b), nil, r.tok["Dev3"])
	}
	code, out := launch(sibling)
	assert.Equal(t, http.StatusOK, code, "a sibling worktree of the team's repo: %v", out)
	code, out = launch(t.TempDir())
	assert.Equal(t, http.StatusForbidden, code, "a folder outside the repo: %v", out)
	assert.Equal(t, "outside_team_folder", out["code"])
	// a link inside the team's worktree that leads out of it does not count
	outside := t.TempDir()
	link := filepath.Join(wt, "escape")
	if err := os.Symlink(outside, link); err == nil {
		code, out = launch(link)
		assert.Equal(t, http.StatusForbidden, code, "a link out of the worktree is refused: %v", out)
		assert.Equal(t, "outside_team_folder", out["code"])
	}
}

// #13903: a launch by a verified session seated on a team whose grant is ON is held to THAT team's cap and log wherever the agent is placed: on no board, on a new board, on another computer's board, as a member of
// a team launch. A launch that names no board goes onto the team's own board. Off or absent grants, the Operator and callers with no session are as they were.
func TestAnAgentsLaunchWithNoBoardGoesOntoItsOwnTeamWhereTheGrantIsOn(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard() // Orchestrator and Dev2 awake, Dev asleep
	launch := func(extra map[string]any) (int, map[string]any) {
		body := map[string]any{"working_dir": r.work, "agent_type": "claude", "display_name": "Helper"}
		for k, v := range extra {
			body[k] = v
		}
		b, _ := json.Marshal(body)
		return r.do("POST", "/api/sessions/launch", string(b), nil, r.tok["Dev2"])
	}
	boardOf := func(out map[string]any) string {
		sid, _ := out["session_id"].(string)
		ls, err := r.ss.GetLiveSession(ctx, sid)
		require.NoError(t, err)
		require.NotNil(t, ls)
		if ls.BoardName == nil {
			return ""
		}
		return *ls.BoardName
	}
	// no grant row: as it was, on no board
	code, out := launch(nil)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "", boardOf(out), "grant absent: unchanged")
	// the grant on: the launch is on the team, logged, and under the cap
	code, _ = r.operatorGrant("Orchestrator", map[string]any{"max_live": 2, "max_per_hour": 50})
	require.Equal(t, http.StatusOK, code)
	code, out = launch(nil)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, orchBoard, boardOf(out), "the grant on: its own team")
	log, err := r.h.bs.LifecycleLog(ctx, orchBoard, 20)
	require.NoError(t, err)
	var launches int
	for _, e := range log {
		if e.Kind == board.LifecycleLaunch {
			launches++
		}
	}
	assert.Equal(t, 1, launches, "logged to the team")
	// one more fits (Dev2 and the first helper are live besides the seat: two), the next is the cap
	code, out = launch(nil)
	assert.Equal(t, http.StatusTooManyRequests, code, "the cap holds for a launch that forgot the board: %v", out)
	assert.Equal(t, "board_live_limit", out["code"])
	// off again: as it was
	code, _ = r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", `{"enabled":false,"max_live":2,"max_per_hour":50,"idle_minutes":5}`, operatorClient, "")
	require.Equal(t, http.StatusOK, code)
	code, out = launch(nil)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "", boardOf(out), "the grant off: unchanged")
	// the Operator's launch with no board is never put on a team
	b, _ := json.Marshal(map[string]any{"working_dir": r.work, "agent_type": "claude", "display_name": "Mine"})
	code, out = r.do("POST", "/api/sessions/launch", string(b), operatorClient, "")
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "", boardOf(out))
}

// Every spelling of "somewhere else" is held to the calling team's cap, log and folders (the Orchestrator's rule on #13903): a new board, another computer's board and the members of a team launch.
func TestEverySpellingOfSomewhereElseIsHeldToTheCallersTeam(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard() // Dev2 is live besides the seat
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"max_live": 3, "max_per_hour": 50})
	require.Equal(t, http.StatusOK, code)
	launch := func(extra map[string]any) (int, map[string]any) {
		body := map[string]any{"working_dir": r.work, "agent_type": "claude", "display_name": "Helper"}
		for k, v := range extra {
			body[k] = v
		}
		b, _ := json.Marshal(body)
		return r.do("POST", "/api/sessions/launch", string(b), nil, r.tok["Dev2"])
	}
	logged := func() int {
		log, err := r.h.bs.LifecycleLog(ctx, orchBoard, 50)
		require.NoError(t, err)
		n := 0
		for _, e := range log {
			if e.Kind == board.LifecycleLaunch {
				n++
			}
		}
		return n
	}
	// a new board: allowed as before, and it is the team's launch: logged to the team, counted against its cap
	code, out := launch(map[string]any{"board_name": "elsewhere", "new_board": true})
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, 1, logged(), "a launch on a new board is logged to the caller's team")
	// a second one fills the team (Dev2 and two helpers: three), the third is the live cap: the agents placed elsewhere count
	code, out = launch(map[string]any{"board_name": "elsewhere2", "new_board": true})
	require.Equal(t, http.StatusOK, code, out)
	code, out = launch(map[string]any{"board_name": "elsewhere3", "new_board": true})
	assert.Equal(t, http.StatusTooManyRequests, code, "the agents started on other boards count: %v", out)
	assert.Equal(t, "board_live_limit", out["code"])
	// another computer's board and no board at all are held the same way
	code, out = launch(map[string]any{"board_name": "far", "board_server": "faraway"})
	assert.Equal(t, http.StatusTooManyRequests, code, "a remote board is the caller's team's launch: %v", out)
	assert.Equal(t, "board_live_limit", out["code"])
	code, out = launch(nil)
	assert.Equal(t, http.StatusTooManyRequests, code, out)
	assert.Equal(t, "board_live_limit", out["code"])
	// the folder rule is the caller's team's wherever the agent goes
	code, out = launch(map[string]any{"working_dir": t.TempDir(), "board_name": "elsewhere4", "new_board": true})
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.Equal(t, "outside_team_folder", out["code"])
	// a team launch: raise the cap to leave room for one, two members go to a new board: one starts, one is refused with the cap named
	code, _ = r.operatorGrant("Orchestrator", map[string]any{"max_live": 4, "max_per_hour": 50})
	require.Equal(t, http.StatusOK, code)
	b, _ := json.Marshal(map[string]any{"board_name": "newteam", "new_board": true, "working_dir": r.work, "agent_type": "claude", "agents": []map[string]any{{"name": "M1", "prompt": "work"}, {"name": "M2", "prompt": "work"}}})
	code, out = r.do("POST", "/api/sessions/launch-team", string(b), nil, r.tok["Dev2"])
	require.Equal(t, http.StatusOK, code, out)
	ms := out["agents"].([]any)
	require.Len(t, ms, 2)
	assert.Nil(t, ms[0].(map[string]any)["error"], "one fits")
	assert.Equal(t, "board_live_limit", ms[1].(map[string]any)["code"], "the member over the cap is refused: %v", ms[1])
	// a team launch outside the team's folder is refused whole
	b, _ = json.Marshal(map[string]any{"board_name": "newteam2", "new_board": true, "working_dir": t.TempDir(), "agent_type": "claude", "agents": []map[string]any{{"name": "M3", "prompt": "work"}}})
	code, out = r.do("POST", "/api/sessions/launch-team", string(b), nil, r.tok["Dev2"])
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.Equal(t, "outside_team_folder", out["code"])
	// a board with no grant, and the Operator, are not held to any team
	other := r.seat("Loner", "Developer", "lonely-board", "claude", false, 9)
	_ = other
	bo, _ := json.Marshal(map[string]any{"working_dir": t.TempDir(), "agent_type": "claude", "display_name": "Free", "board_name": "free", "new_board": true})
	code, out = r.do("POST", "/api/sessions/launch", string(bo), nil, r.tok["Loner"])
	assert.Equal(t, http.StatusOK, code, "a team with no grant is as it was: %v", out)
	code, out = r.do("POST", "/api/sessions/launch", string(bo), operatorClient, "")
	assert.Equal(t, http.StatusOK, code, "the Operator is never held: %v", out)
}

// QA's SHOULD on #13891: only the Coral Hub OWNER's team launch seeds the grant; a Hub user who holds the Launch tier (a grantee) launches the same team and gets none.
func TestOnlyTheHubOwnersTeamLaunchSeedsTheGrant(t *testing.T) {
	r := newOrchRig(t)
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	hub := func(boardName string, hdr map[string]string) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", strings.NewReader(defTeamBody(boardName, r.work, "Orchestrator", "Dev")))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		actor, ok := actorFor(req, callerHub)
		require.True(t, ok)
		req = withActor(req, actor)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerHub))
		rec := httptest.NewRecorder()
		r.h.LaunchTeam(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	ctx := context.Background()
	out := hub("viaowner", ownerHeaders(ownerLabel))
	g, err := r.h.bs.GetOrchGrant(ctx, out["board_id"].(string))
	require.NoError(t, err)
	assert.True(t, g.Enabled, "the Hub owner's launch seeds the grant")
	out = hub("viagrantee", granteeHeaders())
	g, err = r.h.bs.GetOrchGrant(ctx, out["board_id"].(string))
	require.NoError(t, err)
	assert.False(t, g.Enabled, "a Hub user at the Launch tier is not the Operator: no grant")
	assert.Empty(t, g.SeatSession)
}
