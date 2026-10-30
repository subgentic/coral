package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11198: read of a paused board is empty and says why (a header), and check gives the real count with paused: true, the number the Stop hook counts; neither is a bare "nothing new".
func TestAPausedBoardsReadAndCheckSayItIsPaused(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-dev-session", nil, "mentions")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.PostMessage(ctx, "team", "Lead", "@Dev please look", nil)
	require.NoError(t, err)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/messages", h.ReadMessages)
	r.Get("/api/board/{project}/messages/check", h.CheckUnread)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	h.SetPaused("team", true)
	resp, err := http.Get(srv.URL + "/api/board/team/messages?subscriber_id=Dev")
	require.NoError(t, err)
	var msgs []any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&msgs))
	resp.Body.Close()
	assert.Empty(t, msgs, "a paused board delivers nothing")
	

	resp, err = http.Get(srv.URL + "/api/board/team/messages/check?subscriber_id=Dev")
	require.NoError(t, err)
	var chk map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&chk))
	resp.Body.Close()
	assert.EqualValues(t, 1, chk["unread"], "the real count, as the Stop hook counts it")
	assert.Equal(t, true, chk["paused"])

	h.SetPaused("team", false)
	resp, err = http.Get(srv.URL + "/api/board/team/messages?subscriber_id=Dev")
	require.NoError(t, err)
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&msgs))
	resp.Body.Close()
	assert.Len(t, msgs, 1)
	assert.Empty(t, resp.Header.Get(BoardPausedHeader))
	resp, err = http.Get(srv.URL + "/api/board/team/messages/check?subscriber_id=Dev")
	require.NoError(t, err)
	chk = nil
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&chk))
	resp.Body.Close()
	assert.NotContains(t, chk, "paused")
}
