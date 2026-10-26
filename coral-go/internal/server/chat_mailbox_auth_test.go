package server

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

func TestChatMailboxRealRouterIdentityAndTunnel(t *testing.T) {
	r := newE2ERemote(t, "chat-mailbox", nil)
	h := r.srv.Router()
	ctx := t.Context()
	ss := store.NewSessionStore(r.db)
	require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: "chat", SourceType: "codex", SourceFile: "/fixture/chat"}))
	token, err := r.db.MintSessionToken(ctx, "agent", "codex-test")
	require.NoError(t, err)
	agent := map[string]string{store.SessionTokenHeader: token, "Content-Type": "application/json"}
	for _, c := range [][2]string{{"GET", "/api/sessions/history/counts"}, {"PATCH", "/api/sessions/history/chat/flags"}} {
		got := call(h, c[0], c[1], `{"starred":true}`, agent)
		assert.Equal(t, 403, got.Code)
		assert.Contains(t, got.Body.String(), "forbidden_for_agent")
	}
	operator := map[string]string{"Authorization": "Bearer " + r.srv.keyStore.Key(), "Content-Type": "application/json"}
	require.Equal(t, 200, call(h, "PATCH", "/api/sessions/history/chat/flags", `{"starred":true}`, operator).Code)
	require.Equal(t, 200, call(h, "GET", "/api/sessions/history/counts", "", operator).Code)
	through := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	for _, mode := range []string{"view", "interact", "launch"} {
		require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"`+mode+`"}`, map[string]string{"Content-Type": "application/json"}).Code)
		assert.Equal(t, 200, call(h, "GET", "/api/sessions/history/counts", "", through).Code, "counts retain history read tier at "+mode)
		assert.Equal(t, 403, call(h, "PATCH", "/api/sessions/history/chat/flags", `{"archived":true}`, through).Code, "flags remain local at "+mode)
	}
}
