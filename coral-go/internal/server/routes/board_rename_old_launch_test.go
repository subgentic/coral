package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #19724: a team's name held by a previous team has a third choice besides join and another board: relabel the old team <name>-YYYY-MM-DD and start the new one.
func TestRenameOldBoardFreesTheNameForANewTeam(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stubCLIPaths(t, store.NewSessionStore(db))
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	handler := NewSessionsHandler(db, &config.Config{LogDir: t.TempDir()}, nil, newMockTerminal(), bs)
	handler.SetTeamStore(store.NewTeamStore(db))
	ctx := context.Background()
	today := time.Now().Format("2006-01-02")

	call := func(extra map[string]any) (int, map[string]any) {
		body := map[string]any{"working_dir": t.TempDir(), "agents": []map[string]any{{"name": "Dev", "prompt": "build"}}}
		for k, v := range extra {
			body[k] = v
		}
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.LaunchTeam(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	// A previous team with no running agent: a board with history.
	old, err := bs.CreateBoard(ctx, "alpha", "operator")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, old.ID, "someone", "the old team's message", nil)
	require.NoError(t, err)
	task, err := bs.CreateTask(ctx, old.ID, "the old team's task", "", "medium", "someone")
	require.NoError(t, err)

	// The refusal offers it, with the name it would use.
	code, out := call(map[string]any{"board_name": "alpha"})
	require.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, "board_name_exists", out["code"])
	assert.Equal(t, "alpha-"+today, out["rename_to"], "the suggested name for the old team")

	// Taking it renames the old team and starts the new one under the name.
	code, out = call(map[string]any{"board_name": "alpha", "rename_old_board": true})
	require.Equal(t, http.StatusOK, code, out)
	got, err := bs.GetBoard(ctx, old.ID)
	require.NoError(t, err)
	assert.Equal(t, "alpha-"+today, got.Label, "only the label changed")
	fresh, err := bs.BoardsLabelled(ctx, "alpha")
	require.NoError(t, err)
	require.Len(t, fresh, 1)
	assert.NotEqual(t, old.ID, fresh[0].ID, "the new team is a new board")

	// The old team's history is still there, under its new name.
	msgs, err := bs.ListMessages(ctx, old.ID, 50, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	assert.Equal(t, "the old team's message", msgs[0].Content)
	tasks, err := bs.ListTasks(ctx, old.ID)
	require.NoError(t, err)
	require.Len(t, tasks, 1)
	assert.Equal(t, task.ID, tasks[0].ID)
	assert.Equal(t, old.ID, func() string { id, _, _ := bs.ResolveBoard(ctx, "alpha-"+today); return id }(), "reachable by its new name")

	// A second team of the same name on the same day: the date is taken, so -2.
	again, err := bs.CreateBoard(ctx, "beta", "operator")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, again.ID, "someone", "x", nil)
	require.NoError(t, err)
	dated, err := bs.CreateBoard(ctx, "beta-"+today, "operator")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, dated.ID, "someone", "y", nil)
	require.NoError(t, err)
	code, out = call(map[string]any{"board_name": "beta"})
	require.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, "beta-"+today+"-2", out["rename_to"], "the dated name is taken: -2")
	code, out = call(map[string]any{"board_name": "beta", "rename_old_board": true})
	require.Equal(t, http.StatusOK, code, out)
	got, err = bs.GetBoard(ctx, again.ID)
	require.NoError(t, err)
	assert.Equal(t, "beta-"+today+"-2", got.Label)

	// A team with a running agent is not renamed under it: a code of its own, and the old label stays.
	code, out = call(map[string]any{"board_name": "gamma"})
	require.Equal(t, http.StatusOK, code, out)
	gamma, err := bs.BoardsLabelled(ctx, "gamma")
	require.NoError(t, err)
	require.Len(t, gamma, 1)
	code, out = call(map[string]any{"board_name": "gamma"})
	require.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, "running_agents", out["rename_blocked"], "the choice says why it is not offered")
	code, out = call(map[string]any{"board_name": "gamma", "rename_old_board": true})
	require.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, "board_has_running_agents", out["code"])
	still, err := bs.GetBoard(ctx, gamma[0].ID)
	require.NoError(t, err)
	assert.Equal(t, "gamma", still.Label, "nothing was renamed")

	// An agent's token is refused: relabelling another team is the Operator's choice.
	handler.SetAgentOperatorGate(func(*http.Request, string) bool { return true })
	delta, err := bs.CreateBoard(ctx, "delta", "operator")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, delta.ID, "someone", "x", nil)
	require.NoError(t, err)
	code, out = call(map[string]any{"board_name": "delta", "rename_old_board": true})
	require.Equal(t, http.StatusForbidden, code, out)
	assert.Equal(t, "forbidden_for_agent", out["code"])
	again2, err := bs.BoardsLabelled(ctx, "delta")
	require.NoError(t, err)
	assert.Len(t, again2, 1, "the old team keeps its name")
}
