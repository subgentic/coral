package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
)

func runCheck(t *testing.T, f *fakeCoral, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := runCLICheck(append(args, "--url", f.srv.URL), &out, &errb)
	return code, out.String(), errb.String()
}

func cliFake(t *testing.T) *fakeCoral {
	f := newFakeCoral(t, ready, enrolled)
	f.cliReply = map[string]string{
		"claude": `{"found":true,"path":"/usr/local/bin/claude","version":"2.1.300","probe":"ok","agent_type":"claude"}`,
		"codex":  `{"found":false,"install_command":"npm install -g @openai/codex","agent_type":"codex"}`,
	}
	return f
}

// With no type, every agent type is listed, one line each: found with its path and version, or not found; the exit code is 0.
func TestCLICheckListsEveryAgentTypeOnItsOwnLine(t *testing.T) {
	f := cliFake(t)
	code, out, errb := runCheck(t, f)
	require.Equal(t, 0, code, errb)
	lines := strings.Split(strings.TrimSpace(out), "\n")
	assert.Len(t, lines, len(agent.CLITypes()), out)
	assert.Contains(t, out, "claude")
	assert.Contains(t, out, "found  /usr/local/bin/claude  2.1.300")
	assert.Contains(t, out, "not found (install: npm install -g @openai/codex)")
	assert.Equal(t, len(agent.CLITypes()), len(f.callList()), "one signed call per type")
}

// A named type that is found exits 0 and prints its path and version; one that is missing exits 1.
func TestCLICheckExitsOneWhenTheNamedTypeIsMissing(t *testing.T) {
	f := cliFake(t)
	code, out, _ := runCheck(t, f, "claude")
	assert.Equal(t, 0, code)
	assert.Equal(t, "claude       found  /usr/local/bin/claude  2.1.300\n", out)
	code, out, _ = runCheck(t, f, "codex")
	assert.Equal(t, 1, code, out)
	assert.Contains(t, out, "codex")
	assert.Contains(t, out, "not found")
	code, _, _ = runCheck(t, f, "--home", t.TempDir(), "codex") // the type may come after a flag
	assert.NotEqual(t, 0, code)
}

// A type Coral does not know is a usage error and calls nothing: the server would answer an unknown type as found.
func TestCLICheckRefusesAnUnknownTypeAndSendsNothing(t *testing.T) {
	f := cliFake(t)
	code, _, errb := runCheck(t, f, "clod")
	assert.Equal(t, 2, code)
	assert.Contains(t, errb, "not an agent type Coral knows")
	code, _, errb = runCheck(t, f, "claude", "codex")
	assert.Equal(t, 2, code)
	assert.Contains(t, errb, "usage:")
	assert.Empty(t, f.callList())
}

// Only this computer's Coral is asked, and the request is signed: an address that is not this computer is refused before any call.
func TestCLICheckTalksToThisComputerOnly(t *testing.T) {
	f := cliFake(t)
	var out, errb bytes.Buffer
	code := runCLICheck([]string{"claude", "--url", "http://203.0.113.5:8420"}, &out, &errb)
	assert.Equal(t, 2, code)
	assert.Contains(t, errb.String(), "not this computer")
	assert.Empty(t, f.callList())
	code, _, _ = runCheck(t, f, "claude")
	assert.Equal(t, 0, code)
	assert.Zero(t, f.refused, "the call carried a valid signature")
}

// The words of a line: a CLI that cannot run on this OS says why, a configured path that cannot be run says so.
func TestCLICheckLineWords(t *testing.T) {
	no := false
	assert.Equal(t, "agy          not available here: not on Windows", cliCheckLine("agy", cliCheckReply{Supported: &no, Message: "not on Windows"}))
	assert.Equal(t, "pi           not found: the path is wrong", cliCheckLine("pi", cliCheckReply{Configure: true, Message: "the path is wrong"}))
	assert.Equal(t, "claude       found  /p/claude  1.0  (running it did not work: failed)", cliCheckLine("claude", cliCheckReply{Found: true, Path: "/p/claude", Version: "1.0", Probe: "failed"}))
}
