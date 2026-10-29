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
	code, out := do("POST", "/api/sessions/launch", `{"working_dir":"`+work+`","agent_type":"terminal","board_name":"rs-home","display_name":"mover"}`)
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
