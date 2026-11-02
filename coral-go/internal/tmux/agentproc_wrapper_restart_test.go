package tmux

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #408, operator decision: the session's resolved CLI path survives a Coral restart. A wrapper agent is launched (the path is kept with the session), Coral restarts (nothing in memory;
// the recorded process comes back from the tmux session's option, here the load function), and a notice still goes to the wrapper. A session with no kept path (from before this) still pauses.
func TestAWrapperAgentStillGetsNoticesAfterACoralRestart(t *testing.T) {
	const session = "claude-restart"
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	SetLaunchCLIStore(
		func(s, cli string) { _ = ss.SetLaunchCLI(context.Background(), s, cli) },
		func(s string) string { return ss.LaunchCLI(context.Background(), s) })
	t.Cleanup(func() {
		SetLaunchCLIStore(nil, nil)
		NoteLaunchCLI(session, "")
		ForgetAgentProc(session)
		agentRecs.Lock()
		delete(agentRecs.m, session)
		agentRecs.Unlock()
	})
	_, cli := wrapperFixture(t)
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh")
	rec := AgentProc{PID: 700, Start: t1}
	load := func() (AgentProc, bool) { return rec, true } // what the tmux session's option kept

	// the launch: the path is kept with the session
	NoteLaunchCLI(session, cli)

	// a Coral restart: nothing in memory
	launchCLIs.Lock()
	launchCLIs.m = map[string]string{}
	launchCLIs.Unlock()
	agentRecs.Lock()
	delete(agentRecs.m, session)
	agentRecs.Unlock()

	v := noticeVerdict(pane, 600, session, load)
	assert.True(t, v.OK, "the path is read back from the database and the wrapper is re-checked as before: %+v", v)

	// the re-check still holds after the restart: the wrapper became a person's shell
	withArgs(t, map[int][]string{700: {"bash", "-i"}}, nil)
	launchCLIs.Lock()
	launchCLIs.m = map[string]string{}
	launchCLIs.Unlock()
	agentRecs.Lock()
	delete(agentRecs.m, session)
	agentRecs.Unlock()
	assert.False(t, noticeVerdict(pane, 600, session, load).OK)
}

func TestASessionWithNoKeptCLIPathStillPausesAfterARestart(t *testing.T) {
	const session = "claude-oldsession"
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	SetLaunchCLIStore(
		func(s, cli string) { _ = ss.SetLaunchCLI(context.Background(), s, cli) },
		func(s string) string { return ss.LaunchCLI(context.Background(), s) })
	t.Cleanup(func() {
		SetLaunchCLIStore(nil, nil)
		ForgetAgentProc(session)
		agentRecs.Lock()
		delete(agentRecs.m, session)
		agentRecs.Unlock()
	})
	_, cli := wrapperFixture(t)
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh")
	rec := AgentProc{PID: 700, Start: t1}

	// no note was ever kept for this session (it was launched before this change): the recorded shell is not the agent
	v := noticeVerdict(pane, 600, session, func() (AgentProc, bool) { return rec, true })
	assert.False(t, v.OK, "fail safe: notices wait for a record, as before")

	// Record as agent keeps the path with the session (NoteLaunchCLI), and the notices flow again
	NoteLaunchCLI(session, cli)
	agentRecs.Lock()
	delete(agentRecs.m, session)
	agentRecs.Unlock()
	assert.True(t, noticeVerdict(pane, 600, session, func() (AgentProc, bool) { return rec, true }).OK)
	assert.Equal(t, cli, ss.LaunchCLI(context.Background(), session), "and it is in the database")
}
