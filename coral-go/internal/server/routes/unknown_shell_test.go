package routes

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// unknownShellTerminal is a terminal whose agent CLI has exited (fgSessionTerminal) and whose shell runs a shell of unknown contents
// (git-bash's bash, WSL) for the names in other.
type unknownShellTerminal struct {
	*fgSessionTerminal
	other map[string]string
}

func (u *unknownShellTerminal) AgentUnknownShell(_ context.Context, name, _, _ string) (string, bool) {
	return u.other[strings.TrimSuffix(name, ".0")], true
}

// #216 (Security's guard): Wake of an agent whose terminal runs a shell of unknown contents types no launch line into it (a program
// may run inside, invisible to the process walk), clears the sleeping flag as for a running terminal, and says why.
func TestWakeTypesNoLaunchLineIntoAShellOfUnknownContents(t *testing.T) {
	_, handler, mock, ss := setupSessionsTestServer(t)
	term := &unknownShellTerminal{fgSessionTerminal: newFGTerminal(mock), other: map[string]string{}}
	handler.terminal = term
	r := chi.NewRouter()
	r.Post("/api/sessions/live/{sessionID}/wake", handler.WakeSession)
	srv := httptestServer(t, r)

	name := naming.SessionName("claude", exitedTestSID)
	wd := t.TempDir()
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: exitedTestSID, AgentType: "claude", AgentName: "repo", WorkingDir: wd, IsSleeping: 1}))
	require.NoError(t, mock.CreateSession(context.Background(), name, wd))
	term.setFG(name, "powershell") // the agent CLI has exited ...
	term.other[name] = "bash"      // ... and the person started git-bash there

	out := postArchiveOK(t, srv+"/api/sessions/live/"+exitedTestSID+"/wake")
	assert.Empty(t, term.sentTo(name+".0"), "no launch line typed into the shell of unknown contents")
	assert.Empty(t, term.sentTo(name), "nor to the pane by its plain name")
	assert.Equal(t, ptymanager.UnknownShellRefusal("bash"), out["note"], "the reply says why and what to do")
	s, _ := archFlags(t, ss, exitedTestSID)
	assert.Equal(t, 0, s, "awake, as for a running terminal")
}

// The check is made when the launch line is typed, which may be a spaced start's later slot: sendLaunchCommand refuses then, whoever
// called it (Wake, a launch, a resume).
func TestALaunchLineIsNotTypedIntoAShellOfUnknownContents(t *testing.T) {
	_, _, mock, _ := setupSessionsTestServer(t)
	term := &unknownShellTerminal{fgSessionTerminal: newFGTerminal(mock), other: map[string]string{"claude-x": "bash"}}
	err := sendLaunchCommand(context.Background(), term, "claude-x", "claude --resume")
	require.Error(t, err)
	assert.Equal(t, ptymanager.UnknownShellRefusal("bash"), err.Error())
	assert.Empty(t, term.sentTo("claude-x"))

	term.other["claude-x"] = "" // none: typed as before
	require.NoError(t, sendLaunchCommand(context.Background(), term, "claude-x", "claude --resume"))
	_ = terminalinput.Internal
}

// #13658: the check is made again for a short window before a launch line is refused, because a new pane's shell is still starting and a child shell of that startup is, for a moment, what the process walk
// calls a shell of unknown contents. A shell that goes away within the window is no refusal and the line is typed; one that stays is refused, as before.
type startupShellTerminal struct {
	*fgSessionTerminal
	looks atomic.Int32
	until int32 // the looks that still find a shell
}

func (s *startupShellTerminal) AgentUnknownShell(context.Context, string, string, string) (string, bool) {
	if s.looks.Add(1) <= s.until {
		return "/bin/zsh", true
	}
	return "", true
}

func TestALaunchLineWaitsOutAStartupChildShellAndStillRefusesAShellThatStays(t *testing.T) {
	_, _, mock, _ := setupSessionsTestServer(t)
	t.Cleanup(ptymanager.SetUnknownShellSettle(400*time.Millisecond, 20*time.Millisecond))

	// a pane whose shell is still starting: the first looks find a child shell, a later one the prompt
	starting := &startupShellTerminal{fgSessionTerminal: newFGTerminal(mock), until: 2}
	require.NoError(t, sendLaunchCommand(context.Background(), starting, "claude-y", "claude --resume"), "the startup settled: the line is typed")
	assert.Equal(t, int32(4), starting.looks.Load(), "it looked again until two looks in a row found no shell")
	assert.NotEmpty(t, starting.sentTo("claude-y"), "and the line went to the pane")

	// a shell a person started stays: refused after the window
	staying := &startupShellTerminal{fgSessionTerminal: newFGTerminal(mock), until: 1 << 30}
	err := sendLaunchCommand(context.Background(), staying, "claude-z", "claude --resume")
	require.Error(t, err)
	assert.Equal(t, ptymanager.UnknownShellRefusal("/bin/zsh"), err.Error())
	assert.Empty(t, staying.sentTo("claude-z"), "no launch line typed into a shell of unknown contents")
	assert.Greater(t, staying.looks.Load(), int32(2), "it looked more than once before it refused")
}
