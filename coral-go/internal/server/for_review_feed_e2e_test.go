package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #15996 (coral-hub #208896): through the real router, a Hub's /ws/coral feed (?feed=hub) is sent for_review_events when an artifact is tagged and untagged "for review", each the artifact's id and tagged,
// at once and not at the next tick; a dashboard's socket is sent none.
func TestTheHubsFeedCarriesTheForReviewEventsThroughTheRealRouter(t *testing.T) {
	dir := t.TempDir()
	cfg := newE2EConfig(t, dir)
	cfg.StrictLocalAuth = true
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := mustServer(NewWithKey(cfg, db, stack.backend, stack.terminal, ""))
	t.Cleanup(srv.Close)
	local := httptest.NewServer(srv.Router())
	t.Cleanup(local.Close)
	require.NotNil(t, srv.boardStore)

	r := httptest.NewRequest("GET", local.URL+"/", nil)
	tok, err := srv.keyStore.NewSession(r, auth.SessionByPassword, false)
	require.NoError(t, err)
	cookie := &http.Cookie{Name: srv.keyStore.SessionCookieName(r), Value: tok}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dial := func(query string) *websocket.Conn {
		c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(local.URL, "http")+"/ws/coral"+query, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {local.URL}, "Cookie": {cookie.String()}}})
		require.NoError(t, err)
		t.Cleanup(func() { c.CloseNow() })
		return c
	}
	read := func(c *websocket.Conn, d time.Duration) (map[string]any, bool) {
		rctx, cancel := context.WithTimeout(ctx, d)
		defer cancel()
		_, b, err := c.Read(rctx)
		if err != nil {
			return nil, false
		}
		var m map[string]any
		require.NoError(t, json.Unmarshal(b, &m))
		return m, true
	}
	hub, dash := dial("?feed=hub"), dial("")
	for _, c := range []*websocket.Conn{hub, dash} {
		first, ok := read(c, 10*time.Second)
		require.True(t, ok)
		require.Equal(t, "coral_update", first["type"])
		assert.NotContains(t, first, "for_review_events")
	}

	const obj = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	require.NoError(t, srv.boardStore.SetArtifactTags(ctx, "team-a", obj, []string{"internal", "for review"}))
	var got map[string]any
	for i := 0; i < 20 && got == nil; i++ {
		m, ok := read(hub, 5*time.Second)
		require.True(t, ok, "the Hub's feed ended before the event")
		if _, has := m["for_review_events"]; has {
			got = m
		}
	}
	require.NotNil(t, got)
	assert.JSONEq(t, `[{"artifact":"`+obj+`","tagged":true}]`, string(mustJSON(t, got["for_review_events"])))
	assert.NotContains(t, got, "for_review_gap")

	require.NoError(t, srv.boardStore.SetArtifactTags(ctx, "team-a", obj, nil))
	got = nil
	for i := 0; i < 20 && got == nil; i++ {
		m, ok := read(hub, 5*time.Second)
		require.True(t, ok)
		if _, has := m["for_review_events"]; has {
			got = m
		}
	}
	require.NotNil(t, got)
	assert.JSONEq(t, `[{"artifact":"`+obj+`","tagged":false}]`, string(mustJSON(t, got["for_review_events"])))

	// the dashboard's socket: whatever frames it gets in this time, none names a for-review event
	for {
		m, ok := read(dash, 6*time.Second)
		if !ok {
			break
		}
		assert.NotContains(t, m, "for_review_events")
		assert.NotContains(t, m, "for_review_gap")
	}
}
