package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #11112: the Operator finds the seats an agent made on other teams' boards before #11013 (GET /api/board-seats/foreign) and removes one (DELETE /api/board/{board}/seats/{subscriber}); both are the Operator's
// alone: an agent's token is refused, and the Coral Hub never reaches them.
func TestOperatorFindsAndRemovesAForeignSeat(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	a, err := bs.CreateBoard(ctx, "team-a", "Operator")
	require.NoError(t, err)
	b, err := bs.CreateBoard(ctx, "team-b", "Operator")
	require.NoError(t, err)
	const sid = "eeeeeeee-1112-4000-8000-000000000001"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "wanderer", WorkingDir: "/w", BoardName: &a.ID}))
	tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
	require.NoError(t, err)
	for _, board := range []string{a.ID, b.ID} {
		_, err = bs.Subscribe(ctx, board, "Backend Dev", "Dev", "claude-"+sid, nil, "all") // a name with a space
		require.NoError(t, err)
	}

	do := func(method, path, token string) (int, map[string]any, []any) {
		req, _ := http.NewRequest(method, ts.URL+path, bytes.NewBufferString(""))
		if token != "" {
			req.Header.Set(store.SessionTokenHeader, token)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var obj map[string]any
		var arr []any
		if json.Unmarshal(raw, &obj) != nil {
			_ = json.Unmarshal(raw, &arr)
		}
		return resp.StatusCode, obj, arr
	}
	seatsOf := func(board string) []string {
		_, _, arr := do("GET", "/api/board/"+board+"/subscribers", "")
		var ids []string
		for _, s := range arr {
			ids = append(ids, s.(map[string]any)["subscriber_id"].(string))
		}
		return ids
	}

	code, obj, _ := do("GET", "/api/board-seats/foreign", "")
	require.Equal(t, http.StatusOK, code)
	seats, _ := obj["seats"].([]any)
	require.Len(t, seats, 1, "one foreign seat: team-b's")
	seat := seats[0].(map[string]any)
	assert.Equal(t, b.ID, seat["board_id"])
	assert.Equal(t, "team-b", seat["board_label"])
	assert.Equal(t, "Backend Dev", seat["subscriber_id"])
	assert.Equal(t, a.ID, seat["launch_board"])
	assert.Equal(t, "team-a", seat["launch_board_label"])

	// An agent's token can neither list them nor remove one, its own included.
	code, _, _ = do("GET", "/api/board-seats/foreign", tok)
	assert.Equal(t, http.StatusForbidden, code)
	code, _, _ = do("DELETE", "/api/board/"+b.ID+"/seats/"+url.PathEscape("Backend Dev"), tok)
	assert.Equal(t, http.StatusForbidden, code)
	assert.Contains(t, seatsOf(b.ID), "Backend Dev", "nothing was removed")

	// The Operator removes it; team-a's seat of the same agent stays.
	code, obj, _ = do("DELETE", "/api/board/"+b.ID+"/seats/"+url.PathEscape("Backend Dev"), "")
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, true, obj["ok"])
	assert.NotContains(t, seatsOf(b.ID), "Backend Dev")
	assert.Contains(t, seatsOf(a.ID), "Backend Dev", "its own team's seat is not touched")
	code, obj, _ = do("GET", "/api/board-seats/foreign", "")
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, obj["seats"])

	code, _, _ = do("DELETE", "/api/board/"+b.ID+"/seats/"+url.PathEscape("Backend Dev"), "")
	assert.Equal(t, http.StatusNotFound, code, "a seat that is not there")
	code, _, _ = do("DELETE", "/api/board/no-such-board/seats/x", "")
	assert.Equal(t, http.StatusNotFound, code)
}
