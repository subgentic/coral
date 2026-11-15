package routes

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/opencode"
)

// #16716: OpenCode's `auth login` asks which provider, so the sign-in route opens a Coral terminal and types the login command into it. The command is built by the server from its fixed
// shape (the binary, Coral's own XDG folder); nothing the caller sends reaches it. The refusals of #16714 hold for it too.

type signinTerminalCall struct{ dir, command string }

func opencodeSignInHandler(t *testing.T) (*SystemHandler, *[]signinTerminalCall, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binary")
	}
	bin := filepath.Join(t.TempDir(), "opencode")
	require.NoError(t, os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	t.Setenv("PATH", filepath.Dir(bin)+string(os.PathListSeparator)+"/usr/bin")
	signinStartMu.Lock()
	signinStartAt = map[string]time.Time{}
	signinStartMu.Unlock()
	h := newSystemHandlerForTest(t)
	var calls []signinTerminalCall
	h.SetSigninTerminal(func(ctx context.Context, dir, command string) (map[string]any, error) {
		calls = append(calls, signinTerminalCall{dir, command})
		return map[string]any{"session_name": "terminal-abc", "session_id": "abc"}, nil
	})
	return h, &calls, bin
}

func TestOpencodeSignInOpensATerminalWithTheServersOwnCommand(t *testing.T) {
	h, calls, _ := opencodeSignInHandler(t)
	// A command in the request is not read: only the type is.
	code, out := signIn(t, h, "type=opencode&command=rm+-rf+%2F&dir=%2Ftmp", false, true)
	require.Equal(t, 200, code)
	assert.Equal(t, true, out["started"])
	assert.Equal(t, "terminal-abc", out["session_name"])
	require.Len(t, *calls, 1)
	c := (*calls)[0]
	assert.Equal(t, filepath.Join(h.cfg.CoralDir(), "opencode"), c.dir, "Coral's own folder for it, not a path from the request")
	assert.True(t, strings.HasSuffix(strings.Fields(c.command)[len(strings.Fields(c.command))-2], "auth") || strings.Contains(c.command, "auth login"), c.command)
	bin, err := agent.FindCLI(nil, "opencode")
	require.NoError(t, err)
	assert.Equal(t, agent.OpencodeLoginCommand(bin, opencode.XDGVars(c.dir)), c.command, "built from the fixed shape")
	assert.NotContains(t, c.command, "rm -rf")
}

func TestOpencodeSignInRefusesTheHubAndAnAgent(t *testing.T) {
	h, calls, _ := opencodeSignInHandler(t)
	code, out := signIn(t, h, "type=opencode", true, true)
	assert.Equal(t, 403, code)
	assert.Equal(t, "local_only", out["code"])
	code, _ = signIn(t, h, "type=opencode", false, false)
	assert.Equal(t, 403, code)
	assert.Empty(t, *calls, "no terminal for either")
}

func TestOpencodeSignInWithNoCLIOpensNothing(t *testing.T) {
	h, calls, _ := opencodeSignInHandler(t)
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", t.TempDir())
	code, out := signIn(t, h, "type=opencode", false, true)
	assert.Equal(t, 200, code)
	assert.Equal(t, false, out["started"])
	assert.Equal(t, "cli_not_found", out["reason"])
	assert.Empty(t, *calls)
}

func TestOpencodeSignInIsRateLimitedAndNeedsATerminal(t *testing.T) {
	h, calls, _ := opencodeSignInHandler(t)
	_, out := signIn(t, h, "type=opencode", false, true)
	assert.Equal(t, true, out["started"])
	_, out = signIn(t, h, "type=opencode", false, true)
	assert.Equal(t, false, out["started"])
	assert.Equal(t, "too_soon", out["reason"])
	assert.Len(t, *calls, 1, "a double click opens one terminal")

	signinStartMu.Lock()
	signinStartAt = map[string]time.Time{}
	signinStartMu.Unlock()
	h.SetSigninTerminal(nil)
	_, out = signIn(t, h, "type=opencode", false, true)
	assert.Equal(t, "error", out["reason"], "no way to open a terminal: said, nothing run")
}

// The launch half: a plain terminal started with a sign-in command has that command typed into it; an ordinary terminal still gets nothing typed (#16716).
func TestATerminalLaunchedForSignInTypesTheCommandAndAnOrdinaryOneDoesNot(t *testing.T) {
	_, h, term, _ := setupSessionsTestServer(t)
	dir := t.TempDir()
	res, err := h.LaunchSigninTerminal(context.Background(), dir, "opencode auth login")
	require.NoError(t, err)
	name, _ := res["session_name"].(string)
	require.NotEmpty(t, name)
	term.mu.Lock()
	typed := strings.Join(term.sentOrder, "\n")
	term.mu.Unlock()
	assert.Contains(t, typed, "opencode auth login", "the server's command is typed into the terminal")

	term.mu.Lock()
	before := len(term.sentOrder)
	term.mu.Unlock()
	_, err = h.launchSession(context.Background(), launchSpec{WorkDir: dir, AgentType: "terminal"})
	require.NoError(t, err)
	term.mu.Lock()
	after := len(term.sentOrder)
	term.mu.Unlock()
	assert.Equal(t, before, after, "an ordinary terminal has nothing typed")
}
