package background

import (
	"context"
	"strings"
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
	rt.screens[name] = launchLine(testUUID) + "\ncodex : The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program."

	r.reconcileOnce(ctx)
	assert.True(t, isSleeping(t, ss, testUUID))
	ls, err := ss.GetLiveSession(ctx, testUUID)
	require.NoError(t, err)
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonAgentExited, *ls.SleepReason, "it ended")
	require.NotNil(t, ls.StartFailure)
	assert.Equal(t, store.StartFailureCLIMissing, *ls.StartFailure, "and why")
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
	rt.screens[name] = launchLine(testUUID) + "\nThe term 'git' is not recognized as the name of a cmdlet, function, script file, or operable program."
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
	assert.Equal(t, store.SleepReasonAgentExited, *ls.SleepReason)
	assert.Nil(t, ls.StartFailure, "an ordinary exit is not a failed start")
}

// The window runs from the last launch line Coral typed, a wake's included: an old session whose wake passed the lookup but whose shell still can't find the CLI is caught; the same
// session with no recent launch is not.
func TestReconciler_AWakeWhoseShellCouldNotFindTheCLIIsCaughtByItsLaunchTime(t *testing.T) {
	ss, rt, r := newMissingCLIFixture(t)
	ctx := context.Background()
	registerAwake(t, ss, "codex", testUUID)
	rt.listed = []AgentInfo{{AgentType: "codex", SessionID: testUUID}}
	name := FormatSessionName("codex", testUUID)
	rt.set(name, "powershell")
	rt.screens[name] = launchLine(testUUID) + "\nThe term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program."
	r.now = func() time.Time { return time.Now().Add(3 * time.Hour) } // the row was created hours ago
	r.reconcileOnce(ctx)
	ls, _ := ss.GetLiveSession(ctx, testUUID)
	assert.Nil(t, ls.StartFailure, "created hours ago and never launched since: the words are not the launch's")

	require.NoError(t, ss.StampLaunch(ctx, testUUID)) // a wake typed its line just now
	r.now = time.Now
	r.reconcileOnce(ctx)
	ls, err := ss.GetLiveSession(ctx, testUUID)
	require.NoError(t, err)
	require.NotNil(t, ls.StartFailure)
	assert.Equal(t, store.StartFailureCLIMissing, *ls.StartFailure)
}

// launchLine is the line Coral types to start an agent, as the shell shows it: it sets CORAL_SESSION_ID to the session id.
func launchLine(sessionID string) string {
	return "PS D:/w> $env:CORAL_SESSION_ID = '" + sessionID + "'; & codex --x"
}

// The coral-go-team Security's INFO on #173: only the shell's answer to Coral's own launch line marks an agent. The same words above the line (a
// transcript scrolled up), far below it, or on a screen where the line can't be found (cleared, scrolled past, redrawn) mark nothing; nothing
// is typed either way.
func TestReconciler_OnlyTheShellsAnswerToCoralsLaunchLineMarksAFailedStart(t *testing.T) {
	const err = "codex : The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program."
	for what, screen := range map[string]string{
		"the words above the launch line": err + "\n" + launchLine(testUUID) + "\nPS D:/w> ",
		"the words far below it":          launchLine(testUUID) + "\n" + strings.Repeat("output\n", 20) + err,
		"no launch line on the screen":    err + "\nPS D:/w> ",
	} {
		t.Run(what, func(t *testing.T) {
			ss, rt, r := newMissingCLIFixture(t)
			r.now = func() time.Time { return time.Now() }
			ctx := context.Background()
			registerAwake(t, ss, "codex", testUUID)
			rt.listed = []AgentInfo{{AgentType: "codex", SessionID: testUUID}}
			name := FormatSessionName("codex", testUUID)
			rt.set(name, "powershell")
			rt.screens[name] = screen
			r.reconcileOnce(ctx)
			ls, err := ss.GetLiveSession(ctx, testUUID)
			require.NoError(t, err)
			assert.Nil(t, ls.StartFailure, "not marked failed to start")
			assert.False(t, isSleeping(t, ss, testUUID), "nor ended, inside the launch grace")
			assert.Zero(t, rt.sends)
		})
	}
}
