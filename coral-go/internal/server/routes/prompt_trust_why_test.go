package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14572 (Lead Developer's repro: launch-team, a 240-character folder, the chat offered Yes and the Needs you row showed only "No, exit"): the row says why there is no Yes, in plain words, one reason for
// the one check that refused; the rule is unchanged. A team member's layout (the recorded folder is the team's, its own worktree is the deep path on the screen) is offered a Yes, whatever width the path wraps at.
func TestTrustVerdictSaysWhyThereIsNoYes(t *testing.T) {
	const sid = "00000000-0000-0000-0000-00000000b572"
	home := t.TempDir()
	t.Setenv("HOME", home)
	team := filepath.Join(home, "work", "team")
	deep := filepath.Join(team, "wt", strings.Repeat("deep-folder-name-", 11), "member") // a worktree path of about 240 characters
	require.NoError(t, os.MkdirAll(deep, 0o755))
	other := filepath.Join(home, "work", "elsewhere")
	require.NoError(t, os.MkdirAll(other, 0o755))
	_, h, _, ss := setupSessionsTestServer(t)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "member", WorkingDir: team}))
	require.NoError(t, ss.UpdateWorktreeInfo(context.Background(), sid, deep, team)) // a team member: its worktree is the folder the CLI runs in
	dash := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/chat", nil)
		return r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerDashCookie))
	}
	menu := func(folder string) promptScreen {
		s, ok := parseAgentScreen("claude", trustScreen(t, folder))
		require.True(t, ok)
		require.True(t, isFolderTrustMenu(s))
		return s
	}

	ok, why := h.trustVerdict(dash(), sid, menu(deep))
	assert.True(t, ok, "a team member at its own worktree, however deep: %s", why)
	assert.Empty(t, why)

	// a path wrapped by a narrow terminal is read whole (a 240-character folder at 80 columns is four lines)
	var wrapped []string
	for rest := deep; rest != ""; {
		n := 79
		if n > len(rest) {
			n = len(rest)
		}
		wrapped = append(wrapped, rest[:n])
		rest = rest[n:]
	}
	require.GreaterOrEqual(t, len(wrapped), 3)
	screen := strings.Replace(trustScreen(t, deep), "\n "+deep+"\n", "\n "+strings.Join(wrapped, "\n ")+"\n", 1)
	s, parsed := parseAgentScreen("claude", screen)
	require.True(t, parsed)
	assert.Equal(t, deep, s.TrustFolder, "the wrapped path is read whole")
	ok, _ = h.trustVerdict(dash(), sid, s)
	assert.True(t, ok)

	for name, c := range map[string]struct {
		req    *http.Request
		sid    string
		screen promptScreen
		want   string
	}{
		"an agent or a tool, not the person's dashboard": {httptest.NewRequest(http.MethodGet, "/chat", nil), sid, menu(deep), "own dashboard"},
		"a folder the screen did not name":               {dash(), sid, func() promptScreen { s := menu(deep); s.TrustFolder = ""; return s }(), "could not read which folder"},
		"no session id":                                  {dash(), "", menu(deep), "cannot tell which agent"},
		"a session that is not there":                    {dash(), "00000000-0000-0000-0000-00000000dead", menu(deep), "cannot find this agent's own folder"},
		"another folder than the agent's own":            {dash(), sid, menu(other), "not the one this agent was started in"},
	} {
		ok, why := h.trustVerdict(c.req, c.sid, c.screen)
		assert.False(t, ok, name)
		assert.Contains(t, why, c.want, name)
	}
	// the home folder is the agent's own here, and Coral does not trust it from a row
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "00000000-0000-0000-0000-00000000b573", AgentType: "claude", AgentName: "homey", WorkingDir: home}))
	ok, why = h.trustVerdict(dash(), "00000000-0000-0000-0000-00000000b573", menu(home))
	assert.False(t, ok)
	assert.Contains(t, why, "does not trust this kind of folder")
	// a menu that is not the folder-trust menu has nothing to say
	ok, why = h.trustVerdict(dash(), sid, promptScreen{})
	assert.False(t, ok)
	assert.Empty(t, why)
}
