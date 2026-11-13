package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
)

// #16032 on the real router: the routes that act on one agent (send, keys, answer-prompt; kill, restart, goal, dismiss-wait, sleep, wake: #16074) are behind the guard, so a request the hub routed to another computer is refused before any agent is looked up.
func TestHubRoutedToAnotherComputerIsNeverTypedIntoThroughTheRealRoutes(t *testing.T) {
	srv, ts := bodyLimitServer(t)
	require.NoError(t, store.NewCloudStore(srv.db, store.NewRemoteServerStore(srv.db, srv.cfg.CoralDir())).Save(context.Background(), "https://hub.example", "srv-own", "this computer", "tok"))
	require.NoError(t, store.NewSessionStore(srv.db).SetSetting(context.Background(), routes.MaxModeSetting, "launch")) // this computer lets the hub type into agents and kill, restart, sleep or wake them, so the guard is what answers
	key := srv.keyStore.Key()
	post := func(route, via, server string) int {
		path := "/api/sessions/live/ghost/" + route
		if strings.HasPrefix(route, "team/") {
			path = "/api/sessions/live/" + route
		}
		req, err := http.NewRequest("POST", ts.URL+path, strings.NewReader(`{"command":"x","keys":"x","answer":"x"}`))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		if via != "" {
			req.Header.Set("X-Coral-Via-Tunnel", via)
		}
		if server != "" {
			req.Header.Set("X-Coral-Hub-Server", server)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		_ = b
		return resp.StatusCode
	}
	for _, route := range []string{"send", "keys", "answer-prompt", "goal", "kill", "restart", "dismiss-wait", "sleep", "wake", "team/ghostteam/sleep", "team/ghostteam/wake"} {
		assert.Equal(t, 409, post(route, cloud.ViaSecret(), "srv-other"), route+": routed to another computer")
		assert.NotEqual(t, 409, post(route, cloud.ViaSecret(), "srv-own"), route+": its own id is let through (no such agent here, so not found)")
		assert.NotEqual(t, 409, post(route, "", "srv-other"), route+": the dashboard on this computer is not read for the header")
	}
}
