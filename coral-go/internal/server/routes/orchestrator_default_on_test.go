package routes

import (
	"context"
	"encoding/json"
	"net/http"
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
