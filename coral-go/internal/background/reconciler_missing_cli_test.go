package background

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// missingCLIRuntime is fgReconRuntime that can also be read: the screen per session name (ptymanager.ScreenReader).
type missingCLIRuntime struct {
	fgReconRuntime
	smu     sync.Mutex
	screens map[string]string
	sends   int
}

// SendInput counts what would be typed into a terminal: the net must type nothing.
func (s *missingCLIRuntime) SendInput(context.Context, terminalinput.Origin, string, string) error {
	s.smu.Lock()
	defer s.smu.Unlock()
	s.sends++
	return nil
}

func (s *missingCLIRuntime) AgentScreen(_ context.Context, name, _, _ string) (string, error) {
	s.smu.Lock()
	defer s.smu.Unlock()
	return s.screens[name], nil
}

func newMissingCLIFixture(t *testing.T) (*store.SessionStore, *missingCLIRuntime, *SessionReconciler) {
	t.Helper()
	ss, _, _ := newReconcilerFixture(t)
	rt := &missingCLIRuntime{fgReconRuntime: fgReconRuntime{reconMockRuntime: reconMockRuntime{alive: map[string]bool{}}}, screens: map[string]string{}}
	r := NewSessionReconciler(ss, rt, 0)
	return ss, rt, r
}

// #353, the safety net: a launch line typed although the CLI was nowhere leaves the shell's own error on the screen with the agent at its shell. That is conclusive at once: the agent is
// marked "failed to start" (cli_missing) in the first pass, inside the launch grace, where a plain exit waits for the grace and two passes. It only marks.
func TestReconciler_AgentWhoseShellCouldNotFindItsCLIIsMarkedFailedToStartAtOnce(t *testing.T) {
	ss, rt, r := newMissingCLIFixture(t)
	r.now = func() time.Time { return time.Now() } // just launched: inside the grace
	ctx := context.Background()
	registerAwake(t, ss, "codex", testUUID)
	rt.listed = []AgentInfo{{AgentType: "codex", SessionID: testUUID}}
	name := FormatSessionName("codex", testUUID)
	rt.set(name, "powershell")
	rt.screens[name] = "PS D:/w> & codex --x\ncodex : The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program."

	r.reconcileOnce(ctx)
	assert.True(t, isSleeping(t, ss, testUUID))
	ls, err := ss.GetLiveSession(ctx, testUUID)
	require.NoError(t, err)
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonCLIMissing, *ls.SleepReason)
	assert.Empty(t, rt.killed, "nothing is killed")
	assert.Zero(t, rt.sends, "and nothing is typed into the terminal")
}

func TestReconciler_AnExitedAgentWithAnUnrelatedErrorWaitsForTheGraceAsBefore(t *testing.T) {
	ss, rt, r := newMissingCLIFixture(t)
	r.now = func() time.Time { return time.Now() }
	ctx := context.Background()
	registerAwake(t, ss, "codex", testUUID)
	rt.listed = []AgentInfo{{AgentType: "codex", SessionID: testUUID}}
	name := FormatSessionName("codex", testUUID)
	rt.set(name, "powershell")
	rt.screens[name] = "The term 'git' is not recognized as the name of a cmdlet, function, script file, or operable program."
	for i := 0; i < 3; i++ {
		r.reconcileOnce(ctx)
	}
	assert.False(t, isSleeping(t, ss, testUUID), "another command's error is not the CLI missing")
}

func TestReconciler_ARunningAgentThatPrintedTheSameWordsIsNotEnded(t *testing.T) {
	ss, rt, r := newMissingCLIFixture(t)
	ctx := context.Background()
	registerAwake(t, ss, "codex", testUUID)
	rt.listed = []AgentInfo{{AgentType: "codex", SessionID: testUUID}}
	name := FormatSessionName("codex", testUUID)
	rt.set(name, "node") // the CLI is running
	rt.screens[name] = "bash: codex: command not found"
	for i := 0; i < 3; i++ {
		r.reconcileOnce(ctx)
	}
	assert.False(t, isSleeping(t, ss, testUUID))
}

// The same words on the screen of an agent that was launched long ago are not the launch's: a shell that shows them later is an ordinary exit (reason agent_exited, after the grace and
// the passes), never a failed start.
func TestReconciler_TheSamePhraseLongAfterTheLaunchIsAnOrdinaryExitNotAFailedStart(t *testing.T) {
	ss, rt, r := newMissingCLIFixture(t)
	r.now = func() time.Time { return time.Now().Add(10 * time.Minute) }
	ctx := context.Background()
	registerAwake(t, ss, "codex", testUUID)
	rt.listed = []AgentInfo{{AgentType: "codex", SessionID: testUUID}}
	name := FormatSessionName("codex", testUUID)
	rt.set(name, "powershell")
	rt.screens[name] = "bash: codex: command not found"
	r.reconcileOnce(ctx)
	assert.False(t, isSleeping(t, ss, testUUID), "one pass is not enough for an ordinary exit")
	r.reconcileOnce(ctx)
	ls, err := ss.GetLiveSession(ctx, testUUID)
	require.NoError(t, err)
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonAgentExited, *ls.SleepReason, "not cli_missing")
}
