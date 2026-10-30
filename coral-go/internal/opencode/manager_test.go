package opencode

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTheManagerReadsEachSessionsStateFromItsAgentsEventStream(t *testing.T) {
	cfg, _ := stubConfig(t)
	frames := filepath.Join(t.TempDir(), "frames")
	require.NoError(t, os.WriteFile(frames, []byte(
		"event: session.execution.started\ndata: {\"sessionID\":\"ses_abc123\"}\n\n"+
			"event: session.execution.started\ndata: {\"sessionID\":\"ses_other\"}\n\n"+
			"event: session.execution.succeeded\ndata: {\"sessionID\":\"ses_other\"}\n\n"), 0o600))
	t.Setenv(eventsFileVar, frames)
	m := NewManager(cfg)
	defer m.Close()
	_, ok := func() (State, bool) { s, _, ok := m.Turn("ses_abc123"); return s, ok }()
	assert.False(t, ok, "nothing is known before a server runs")

	_, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	waitFor(t, "ses_other to be idle", func() bool { s, _, ok := m.Turn("ses_other"); return ok && s == StateIdle })
	s, at, ok := m.Turn("ses_abc123")
	require.True(t, ok)
	assert.Equal(t, StateWorking, s)
	assert.WithinDuration(t, time.Now(), at, 5*time.Second)
	_, _, ok = m.Turn("ses_never")
	assert.False(t, ok)
}

func TestEnsureReturnsTheSameServerAndStopLeavesNothingRunning(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	a, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	b, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	assert.Same(t, a, b, "one server per agent")
	other, err := m.Ensure(context.Background(), "agent-2", "")
	require.NoError(t, err)
	assert.NotSame(t, a, other)

	m.Stop("agent-1")
	select {
	case <-a.done:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop left the server running")
	}
	_, err = os.Stat(filepath.Join(cfg.DataDir, "servers", "agent-1", "server.json"))
	assert.True(t, os.IsNotExist(err), "and its pid record is gone")

	m.Close()
	select {
	case <-other.done:
	case <-time.After(5 * time.Second):
		t.Fatal("Close left a server running")
	}
	_, err = m.Ensure(context.Background(), "agent-3", "")
	assert.Error(t, err, "a closed manager starts nothing")
}

func TestAStreamThatEndsForgetsWhatItSaidAndADeadServerIsStartedAgain(t *testing.T) {
	cfg, _ := stubConfig(t)
	frames := filepath.Join(t.TempDir(), "frames")
	require.NoError(t, os.WriteFile(frames, []byte("event: session.execution.started\ndata: {\"sessionID\":\"ses_abc123\"}\n\n"), 0o600))
	t.Setenv(eventsFileVar, frames)
	m := NewManager(cfg)
	defer m.Close()
	srv, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	waitFor(t, "working", func() bool { s, _, ok := m.Turn("ses_abc123"); return ok && s == StateWorking })

	srv.Stop() // the server dies under the stream
	waitFor(t, "the state to be forgotten", func() bool { _, _, ok := m.Turn("ses_abc123"); return !ok })

	again, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	assert.NotSame(t, srv, again, "a server that exited is started again")
	waitFor(t, "working again from the new server's stream", func() bool { s, _, ok := m.Turn("ses_abc123"); return ok && s == StateWorking })
}

func TestAnAgentsTurnIsTheNewestStateOfItsOwnServerAndNoOthers(t *testing.T) {
	cfg, _ := stubConfig(t)
	frames := filepath.Join(t.TempDir(), "frames")
	require.NoError(t, os.WriteFile(frames, []byte(
		"event: session.execution.started\ndata: {\"sessionID\":\"ses_first\"}\n\n"+
			"event: session.execution.succeeded\ndata: {\"sessionID\":\"ses_first\"}\n\n"), 0o600))
	t.Setenv(eventsFileVar, frames)
	m := NewManager(cfg)
	defer m.Close()
	_, _, ok := m.AgentTurn("agent-1")
	assert.False(t, ok, "an agent with no server has no turn")
	_, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	waitFor(t, "idle", func() bool { s, _, ok := m.AgentTurn("agent-1"); return ok && s == StateIdle })
	_, _, ok = m.AgentTurn("agent-2")
	assert.False(t, ok, "another agent's server is not this one's")
}
