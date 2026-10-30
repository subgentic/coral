package opencode

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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

func TestASlowStartOfOneServerHoldsUpNeitherAnotherAgentNorTheStateReads(t *testing.T) {
	cfg, _ := stubConfig(t)
	t.Setenv(listenDelayVar, "1500")
	m := NewManager(cfg)
	defer m.Close()
	started := make(chan error, 2)
	go func() { _, err := m.Ensure(context.Background(), "slow", ""); started <- err }()
	time.Sleep(300 * time.Millisecond) // the first start is under way and still not listening

	t0 := time.Now()
	_, _, ok := m.AgentTurn("other")
	_, _, ok2 := m.Turn("ses_abc123")
	m.Stop("other")
	assert.False(t, ok || ok2)
	assert.Less(t, time.Since(t0), 300*time.Millisecond, "state reads and a stop of another key never wait for a start")

	go func() { _, err := m.Ensure(context.Background(), "slow", ""); started <- err }() // the same key: waits for the first start, shares it
	require.NoError(t, <-started)
	require.NoError(t, <-started)
	m.mu.Lock()
	n := len(m.servers)
	m.mu.Unlock()
	assert.Equal(t, 1, n, "two Ensures of one key made one server")
}

func TestAServerWhoseAgentIsGoneIsReapedAfterItsGraceAndAYoungOneNever(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	gone, err := m.Ensure(context.Background(), "gone", "")
	require.NoError(t, err)
	kept, err := m.Ensure(context.Background(), "kept", "")
	require.NoError(t, err)
	alive := func(key string) bool { return key == "kept" }

	assert.Empty(t, m.Reap(alive, time.Hour), "a young server is never reaped, its agent's row may not be written yet")
	select {
	case <-gone.done:
		t.Fatal("a young server was stopped")
	default:
	}
	assert.Equal(t, []string{"gone"}, m.Reap(alive, 0))
	select {
	case <-gone.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the reaped server is still running")
	}
	select {
	case <-kept.done:
		t.Fatal("an agent that is alive lost its server")
	default:
	}
}

func TestTheReaperRunsUntilCloseAndStopsWhatItReaps(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	srv, err := m.Ensure(context.Background(), "gone", "")
	require.NoError(t, err)
	m.StartReaper(20*time.Millisecond, 0, func(string) bool { return false })
	select {
	case <-srv.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the reaper never stopped a server whose agent is gone")
	}
	m.Close() // waits for the reaper: no goroutine outlives it
}

func TestAStoppedServerLeavesNeitherItsPidRecordNorItsPassword(t *testing.T) {
	cfg, _ := stubConfig(t)
	s, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	p, err := s.PasswordFile()
	require.NoError(t, err)
	_, err = os.Stat(p)
	require.NoError(t, err)
	s.Stop()
	_, err = os.Stat(p)
	assert.True(t, os.IsNotExist(err), "a dead server's password is not kept")
}

func TestAnEnsureOfAKeyWaitsForItsOldServerToBeStoppedAndFindsItsFilesIntact(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	old, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)

	got := make(chan *Server, 1)
	m.beforeStop = func() {
		// the old server is being stopped: a wake of the same agent asks for its server now
		go func() {
			s, err := m.Ensure(context.Background(), "agent-1", "")
			if err == nil {
				got <- s
			}
		}()
		select {
		case <-got:
			t.Error("Ensure started a new server while the old one was still being stopped")
		case <-time.After(300 * time.Millisecond):
		}
	}
	m.Stop("agent-1")
	m.beforeStop = nil
	var fresh *Server
	select {
	case fresh = <-got:
	case <-time.After(10 * time.Second):
		t.Fatal("the Ensure that waited never got its server")
	}
	assert.NotSame(t, old, fresh)
	_, err = os.Stat(filepath.Join(cfg.DataDir, "servers", "agent-1", "server.json"))
	assert.NoError(t, err, "the new server's pid record is still there")
	p, err := fresh.PasswordFile()
	require.NoError(t, err)
	_, err = os.Stat(p)
	assert.NoError(t, err)
}

func TestAnAgentsLastMessageIsReadWhenATurnEndsAndKeptForTheList(t *testing.T) {
	cfg, _ := stubConfig(t)
	frames := filepath.Join(t.TempDir(), "frames")
	require.NoError(t, os.WriteFile(frames, []byte(
		"event: session.execution.started\ndata: {\"sessionID\":\"ses_abc123\"}\n\n"+
			"event: session.execution.succeeded\ndata: {\"sessionID\":\"ses_abc123\"}\n\n"), 0o600))
	t.Setenv(eventsFileVar, frames)
	m := NewManager(cfg)
	defer m.Close()
	_, ok := m.AgentLastMessage("agent-1")
	assert.False(t, ok, "nothing before a server runs")
	_, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	waitFor(t, "the last message", func() bool { _, ok := m.AgentLastMessage("agent-1"); return ok })
	msg, _ := m.AgentLastMessage("agent-1")
	assert.Equal(t, "assistant", msg.Role)
	assert.Equal(t, "hello from the stand-in", msg.Text)
	_, ok = m.AgentLastMessage("agent-2")
	assert.False(t, ok, "another agent's is not this one's")
}

func TestTheReaperStopsOnlyTheServerItJudgedNotOneStartedForTheSameAgentMeanwhile(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	old, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	var fresh *Server
	// the agent is judged gone, and in that moment it is woken: its old server is stopped and a new one started
	stopped := m.Reap(func(key string) bool {
		m.Stop(key)
		fresh, err = m.Ensure(context.Background(), key, "")
		return false
	}, 0)
	require.NoError(t, err)
	assert.Empty(t, stopped, "the server that was judged is already gone; the new one was not judged")
	assert.NotSame(t, old, fresh)
	select {
	case <-fresh.done:
		t.Fatal("the reaper stopped the new server of an agent that is alive")
	case <-time.After(200 * time.Millisecond):
	}
	got, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	assert.Same(t, fresh, got)
}

func TestAnAgentsHistoryIsItsNewestSessionsMessagesFromItsServer(t *testing.T) {
	cfg, _ := stubConfig(t)
	frames := filepath.Join(t.TempDir(), "frames")
	require.NoError(t, os.WriteFile(frames, []byte("event: session.execution.started\ndata: {\"sessionID\":\"ses_abc123\"}\n\n"), 0o600))
	t.Setenv(eventsFileVar, frames)
	m := NewManager(cfg)
	defer m.Close()
	_, ok, err := m.AgentMessages(context.Background(), "agent-1")
	require.NoError(t, err)
	assert.False(t, ok, "no server, no history")
	_, err = m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	waitFor(t, "a session to be named", func() bool { _, _, ok := m.AgentTurn("agent-1"); return ok })
	msgs, ok, err := m.AgentMessages(context.Background(), "agent-1")
	require.NoError(t, err)
	require.True(t, ok)
	require.Len(t, msgs, 1)
	assert.Equal(t, "hello from the stand-in", msgs[0].Text)
	again, ok, err := m.AgentMessages(context.Background(), "agent-1")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, msgs, again, "an unchanged stream is answered from what was read")
}

func TestTheLastMessageSkipsWhatCoralTypedAndATurnOfToolsAlone(t *testing.T) {
	cfg, _ := stubConfig(t)
	frames := filepath.Join(t.TempDir(), "frames")
	require.NoError(t, os.WriteFile(frames, []byte("event: session.execution.succeeded\ndata: {\"sessionID\":\"ses_abc123\"}\n\n"), 0o600))
	msgs := filepath.Join(t.TempDir(), "messages")
	// newest first: Coral's nudge, a turn of tool calls with no text, then what the agent really said
	require.NoError(t, os.WriteFile(msgs, []byte(`{"items":[
		{"id":"m3","type":"user","text":"You have 2 unread messages on the message board. Run coral-board read."},
		{"id":"m2","type":"assistant","content":[{"type":"tool","text":""}]},
		{"id":"m1","type":"assistant","text":"the build passes now"}]}`), 0o600))
	t.Setenv(eventsFileVar, frames)
	t.Setenv(messagesFileVar, msgs)
	m := NewManager(cfg)
	m.SkipLast = func(msg Message) bool { return msg.Role == "user" && strings.HasPrefix(msg.Text, "You have 2 unread") }
	defer m.Close()
	_, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	waitFor(t, "the last message", func() bool { _, ok := m.AgentLastMessage("agent-1"); return ok })
	msg, _ := m.AgentLastMessage("agent-1")
	assert.Equal(t, "the build passes now", msg.Text)
}

func TestAResumedAgentShowsItsChatAndLastMessageBeforeAnyEvent(t *testing.T) {
	cfg, _ := stubConfig(t) // no events file: the stream says nothing, as after a Coral restart
	m := NewManager(cfg)
	defer m.Close()
	_, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	_, ok, _ := m.AgentMessages(context.Background(), "agent-1")
	assert.False(t, ok, "before the stored session is known there is nothing to show")

	m.UseSession("agent-1", "../not-a-session")
	_, ok, _ = m.AgentMessages(context.Background(), "agent-1")
	assert.False(t, ok, "an id that is not a session id is ignored")

	m.UseSession("agent-1", "ses_abc123")
	msgs, ok, err := m.AgentMessages(context.Background(), "agent-1")
	require.NoError(t, err)
	require.True(t, ok, "the old messages are there with no event")
	require.Len(t, msgs, 1)
	assert.Equal(t, "hello from the stand-in", msgs[0].Text)
	waitFor(t, "the last message", func() bool { _, ok := m.AgentLastMessage("agent-1"); return ok })
	_, _, turnKnown := m.AgentTurn("agent-1")
	assert.False(t, turnKnown, "and no turn state was made up: that waits for the stream")
}

func TestAStreamOfTextDeltasCausesNoMoreThanOneReReadOfTheHistory(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	_, err := m.Ensure(context.Background(), "agent-1", "")
	require.NoError(t, err)
	m.UseSession("agent-1", "ses_abc123")
	_, ok, err := m.AgentMessages(context.Background(), "agent-1")
	require.NoError(t, err)
	require.True(t, ok)
	g := m.servers["agent-1"]
	for i := 0; i < 50; i++ { // a delta frame: the loop bumps the version for it
		g.mu.Lock()
		g.version++
		g.mu.Unlock()
		_, _, err := m.AgentMessages(context.Background(), "agent-1")
		require.NoError(t, err)
	}
	g.mu.Lock()
	reads := g.reads
	g.mu.Unlock()
	assert.Equal(t, 1, reads, "fifty events inside the interval: the history was read once, not fifty times")
}
