package server

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

func TestChatFlagsDeletedBoardStartsFresh(t *testing.T) {
	r := newE2ERemote(t, "chat-flags-delete", nil)
	h := r.srv.Router()
	ctx := t.Context()
	ss := store.NewSessionStore(r.db)
	operator := map[string]string{"Authorization": "Bearer " + r.srv.keyStore.Key(), "Content-Type": "application/json"}
	for _, name := range []string{"doomed", "kept"} {
		_, err := r.srv.boardStore.Subscribe(ctx, name, "member", "Developer", "", nil, "all")
		require.NoError(t, err)
		_, err = r.srv.boardStore.PostMessage(ctx, name, "member", "a board chat", nil)
		require.NoError(t, err)
		got := call(h, "PATCH", "/api/sessions/history/board:"+name+"/flags", `{"starred":true,"archived":true}`, operator)
		require.Equal(t, 200, got.Code, got.Body.String())
	}
	// A history chat with the same bare id is a separate flag row.
	require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: "doomed", SourceType: "codex", SourceFile: "/fixture/doomed"}))
	got := call(h, "PATCH", "/api/sessions/history/doomed/flags", `{"starred":true,"archived":true}`, operator)
	require.Equal(t, 200, got.Code, got.Body.String())
	got = call(h, "DELETE", "/api/board/doomed", "", operator)
	require.Equal(t, 200, got.Code, got.Body.String())

	var n int
	require.NoError(t, r.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM chat_flags WHERE session_id=?", "board:doomed"))
	assert.Zero(t, n, "deleting the board removes its flag row")
	_, err := r.srv.boardStore.Subscribe(ctx, "doomed", "new-member", "Developer", "", nil, "all")
	require.NoError(t, err)
	_, err = r.srv.boardStore.PostMessage(ctx, "doomed", "new-member", "a new board chat", nil)
	require.NoError(t, err)
	got = call(h, "GET", "/api/sessions/history?type=group", "", operator)
	require.Equal(t, 200, got.Code, got.Body.String())
	var out struct {
		Sessions []struct {
			ID       string `json:"session_id"`
			Starred  bool   `json:"starred"`
			Archived bool   `json:"archived"`
		} `json:"sessions"`
	}
	require.NoError(t, json.Unmarshal(got.Body.Bytes(), &out))
	require.Len(t, out.Sessions, 1, "the recreated board is visible; the other board stays archived")
	assert.Equal(t, "board:doomed", out.Sessions[0].ID)
	assert.False(t, out.Sessions[0].Starred)
	assert.False(t, out.Sessions[0].Archived)
	flags, err := ss.ChatFlagsForBoards(ctx, []string{"kept"})
	require.NoError(t, err)
	assert.Equal(t, store.ChatFlags{Starred: true, Archived: true}, flags["kept"])
	chats, err := ss.ListSessionsPaged(ctx, store.SessionListParams{Archived: true, PageSize: 10})
	require.NoError(t, err)
	require.Len(t, chats.Sessions, 1)
	assert.Equal(t, "doomed", chats.Sessions[0].SessionID)
	assert.True(t, chats.Sessions[0].Starred, "the same bare history id keeps its flags")
	assert.True(t, chats.Sessions[0].Archived)
}
