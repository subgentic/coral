package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #11005 (found by tests/stress/run_search.sh): a restart re-seated the agent on the board of its NEWEST seat, not the board it was launched on. An agent the Operator had also seated on another board
// came back from a restart as that board's "Seated Guest", with its command-line state pointing there. The seat a restart carries over is the one on the live row's board.
func TestRestartKeepsTheLaunchBoardWhenTheOperatorSeatedTheAgentElsewhere(t *testing.T) {
	srv, ts, dir := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	work := strictWorkDir(t, dir)
	do := func(method, path, body string) (int, map[string]any) {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out
	}
	code, out := do("POST", "/api/sessions/launch", launchBody(t, work, "rs-home", "mover"))
	require.Equal(t, http.StatusOK, code, out)
	home, _ := out["board_id"].(string)
	sid, _ := out["session_id"].(string)
	name, _ := out["session_name"].(string)
	require.NotEmpty(t, home)
	require.NotEmpty(t, sid)
	away, err := bs.CreateBoard(ctx, "rs-away", "Operator")
	require.NoError(t, err)
	// The Operator seats this agent on another board too (a later seat than its launch one).
	time.Sleep(1100 * time.Millisecond) // sleep-ok: subscribed_at has a one second resolution: the second seat must be the newer
	_, err = bs.Subscribe(ctx, away.ID, "Seated Guest", "Guest", name, nil, "all")
	require.NoError(t, err)

	code, out = do("POST", "/api/sessions/live/"+name+"/restart", `{"session_id":"`+sid+`","agent_type":"terminal"}`)
	require.Equal(t, http.StatusOK, code, out)
	newSID, _ := out["session_id"].(string)
	require.NotEmpty(t, newSID, "%v", out)
	newName := "terminal-" + newSID
	if v, ok := out["session_name"].(string); ok && v != "" {
		newName = v
	}

	seatHome, err := bs.SessionSubscription(ctx, home, newName)
	require.NoError(t, err)
	assert.NotNil(t, seatHome, "the restarted session holds its seat on the board it was launched on")
	seatAway, err := bs.SessionSubscription(ctx, away.ID, newName)
	require.NoError(t, err)
	assert.Nil(t, seatAway, "and not on the other board")
	live, err := ss.GetLiveSession(ctx, newSID)
	require.NoError(t, err)
	require.NotNil(t, live)
	require.NotNil(t, live.BoardName)
	assert.Equal(t, home, *live.BoardName, "its live row names the launch board")
	raw, err := os.ReadFile(filepath.Join(srv.cfg.CoralDir(), "board_state_"+newName+".json"))
	require.NoError(t, err)
	var state struct {
		Project string `json:"project"`
	}
	require.NoError(t, json.Unmarshal(raw, &state))
	assert.Equal(t, home, state.Project, "its command-line state points at the launch board, not the Operator's other seat")
}

// Security's round 2: the same restart for an agent that has REMOVED its own seat on the launch board while it still holds a seat elsewhere (a leftover of the old subscribe hole, or the Operator's). The newest
// seat of another board must not become its board: it comes back on the board it was launched on, with no seat added elsewhere.
func TestRestartDoesNotFallBackToAnotherBoardsSeatWhenTheLaunchSeatIsGone(t *testing.T) {
	srv, ts, dir := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	work := strictWorkDir(t, dir)
	do := func(method, path, body string) (int, map[string]any) {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out
	}
	code, out := do("POST", "/api/sessions/launch", launchBody(t, work, "rs2-home", "leaver"))
	require.Equal(t, http.StatusOK, code, out)
	home, _ := out["board_id"].(string)
	sid, _ := out["session_id"].(string)
	name, _ := out["session_name"].(string)
	away, err := bs.CreateBoard(ctx, "rs2-away", "Operator")
	require.NoError(t, err)
	time.Sleep(1100 * time.Millisecond) // sleep-ok: subscribed_at has a one second resolution: the foreign seat must be the newer
	_, err = bs.Subscribe(ctx, away.ID, "Leftover Seat", "Guest", name, nil, "all")
	require.NoError(t, err)
	mine, err := bs.SessionSubscription(ctx, home, name)
	require.NoError(t, err)
	require.NotNil(t, mine, "the launch seat")
	_, err = bs.Unsubscribe(ctx, home, mine.SubscriberID) // what `coral-board unsubscribe` does
	require.NoError(t, err)

	code, out = do("POST", "/api/sessions/live/"+name+"/restart", `{"session_id":"`+sid+`","agent_type":"terminal"}`)
	require.Equal(t, http.StatusOK, code, out)
	newSID, _ := out["session_id"].(string)
	require.NotEmpty(t, newSID, "%v", out)
	newName := "terminal-" + newSID
	if v, ok := out["session_name"].(string); ok && v != "" {
		newName = v
	}
	live, err := ss.GetLiveSession(ctx, newSID)
	require.NoError(t, err)
	require.NotNil(t, live)
	require.NotNil(t, live.BoardName)
	assert.Equal(t, home, *live.BoardName, "it comes back on the board it was launched on, not on the leftover seat's board")
	seatAway, err := bs.SessionSubscription(ctx, away.ID, newName)
	require.NoError(t, err)
	assert.Nil(t, seatAway, "no seat was added on the other board")
	if raw, rerr := os.ReadFile(filepath.Join(srv.cfg.CoralDir(), "board_state_"+newName+".json")); rerr == nil {
		var state struct {
			Project string `json:"project"`
		}
		require.NoError(t, json.Unmarshal(raw, &state))
		assert.Equal(t, home, state.Project, "its command-line state is the launch board's")
	}
	seatHome, err := bs.SessionSubscription(ctx, home, newName)
	require.NoError(t, err)
	assert.NotNil(t, seatHome, "and the launch re-seats it on its recorded board")
}

// launchBody is a terminal agent's launch request, JSON-encoded: a Windows working folder has backslashes, which a body built by joining strings turns into invalid JSON (400 before any restart, #11068).
func launchBody(t *testing.T, workDir, board, name string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"working_dir": workDir, "agent_type": "terminal", "board_name": board, "display_name": name})
	require.NoError(t, err)
	return string(raw)
}

func TestLaunchBodyIsValidJSONForAWindowsFolder(t *testing.T) {
	win := `D:\a\coral\coral\coral-go\internal\server\work-123`
	var got map[string]string
	require.NoError(t, json.Unmarshal([]byte(launchBody(t, win, "b", "n")), &got), "a Windows folder is encoded, not pasted into the JSON")
	assert.Equal(t, win, got["working_dir"])
	// what the tests did before, to show it was invalid
	assert.Error(t, json.Unmarshal([]byte(`{"working_dir":"`+win+`"}`), &got), "pasted, the backslashes make an invalid escape")
}
