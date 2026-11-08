package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14662 (beta run 5 could not try a trust row without a real home): with a fake HOME in a temp folder, what the Needs you trust row says for each kind of folder, through the real chat route as the
// person's own dashboard. A project one level deeper than a direct child of home is offered Yes; a direct child of home (home/proj), home itself, a hidden folder under it and a folder anyone can write
// into are named but not offered, and each says why in the plain sentence the row shows. (The folder-trust rule refuses a DIRECT child of home on purpose: it would trust every project under it.)
func TestTheTrustRowForFoldersUnderAFakeHome(t *testing.T) {
	const sid = "00000000-0000-0000-0000-00000000c662"
	home := t.TempDir()
	t.Setenv("HOME", home)
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
		t.Setenv("HOME", home)
	}
	mk := func(parts ...string) string {
		p := filepath.Join(append([]string{home}, parts...)...)
		require.NoError(t, os.MkdirAll(p, 0o755))
		return p
	}
	outside := filepath.Join(t.TempDir(), "writable") // a folder outside the fake home that every user can write into
	require.NoError(t, os.MkdirAll(outside, 0o777))
	require.NoError(t, os.Chmod(outside, 0o777))
	if resolved, err := filepath.EvalSymlinks(outside); err == nil {
		outside = resolved
	}

	cases := []struct {
		name    string
		folder  string
		offered bool
		why     string // a part of the plain sentence the row shows when there is no Yes
	}{
		{"a project one level deeper than a direct child of home", mk("work", "proj"), true, ""},
		{"a project three levels down", mk("a", "b", "c"), true, ""},
		{"a direct child of home (home/proj)", mk("proj"), false, "directly under your home folder"},
		{"home itself", home, false, "your home folder"},
		{"a folder that holds home", filepath.Dir(home), false, "your home folder"},
		{"a hidden folder under home", mk(".agents", "x"), false, "hidden one"},
		{"a folder outside home that everyone can write into", outside, false, "other people on this computer can write into"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			server, _, terminal, ss := setupSessionsTestServer(t)
			require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "claude-trust", WorkingDir: c.folder}))
			terminal.addSession("claude-trust", "/tmp/test")
			fastPromptChecks(t)
			terminal.mu.Lock()
			terminal.outputs["claude-trust"] = trustScreen(t, c.folder)
			terminal.mu.Unlock()
			req, err := http.NewRequest(http.MethodGet, server.URL+"/api/sessions/live/claude-trust/chat?"+url.Values{"session_id": {sid}, "agent_type": {"claude"}, "after": {"1"}}.Encode(), nil)
			require.NoError(t, err)
			req.Header.Set("Sec-Fetch-Site", "same-origin") // the person's own dashboard
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()
			var reply struct {
				PromptOptions promptScreen `json:"prompt_options"`
			}
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&reply))
			po := reply.PromptOptions
			assert.Equal(t, c.folder, po.TrustFolder, "the folder the row names")
			assert.Equal(t, c.offered, po.TrustOffer, "Yes offered: %s", po.TrustWhy)
			if c.offered {
				assert.Empty(t, po.TrustWhy)
			} else {
				assert.Contains(t, po.TrustWhy, c.why)
			}
		})
	}
}
