package routes

import (
	"context"
	"strings"
	"testing"

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
