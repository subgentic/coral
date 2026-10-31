package opencode

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// noStartGaps lets a test open several readers in a row (the gaps have a test of their own).
func noStartGaps(t *testing.T) {
	t.Helper()
	a, b := readerStartGap, readerAgentGap
	readerStartGap, readerAgentGap = 0, 0
	t.Cleanup(func() { readerStartGap, readerAgentGap = a, b })
}

func readers(m *Manager) (n int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, g := range m.servers {
		if g.reader {
			n++
		}
	}
	return n
}

// #11390: the chat of an agent with no server (asleep, after a Coral restart) is read through a server started only to read it, on the agent's own store and the newest session it named.
func TestAnAgentWithNoServerHasItsHistoryReadThroughAReaderServer(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	msgs, ok, err := m.ReadHistory(context.Background(), "agent-1", "")
	require.NoError(t, err)
	assert.False(t, ok, "no session was ever named: nothing to read")
	assert.Zero(t, readers(m), "and no server was started for it")

	noteAgentSession(cfg.DataDir, "agent-1", "ses_abc123")
	msgs, ok, err = m.ReadHistory(context.Background(), "agent-1", "")
	require.NoError(t, err)
	require.True(t, ok)
	require.Len(t, msgs, 1)
	assert.Equal(t, "hello from the stand-in", msgs[0].Text)
	assert.Equal(t, 1, readers(m))

	again, ok, err := m.ReadHistory(context.Background(), "agent-1", "")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, msgs, again, "the same server answers: a chat that polls starts nothing more")
	assert.Equal(t, 1, readers(m))
}

func TestAtMostTwoReadersRunAndAnAwakeAgentsIsNeverStoppedForANewOne(t *testing.T) {
	noStartGaps(t)
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	for _, k := range []string{"a-1", "a-2", "a-3"} {
		noteAgentSession(cfg.DataDir, k, "ses_abc123")
	}
	_, ok, _ := m.ReadHistory(context.Background(), "a-1", "")
	require.True(t, ok)
	time.Sleep(20 * time.Millisecond)
	_, ok, _ = m.ReadHistory(context.Background(), "a-2", "")
	require.True(t, ok)
	require.Equal(t, 2, readers(m))

	// every reader's agent is awake: a third is refused, nobody is stopped
	m.mu.Lock()
	m.alive = func(string) bool { return true }
	m.mu.Unlock()
	_, ok, _ = m.ReadHistory(context.Background(), "a-3", "")
	assert.False(t, ok, "refused: no room and no agent to ask to give one up")
	assert.Equal(t, 2, readers(m))

	// the agents are asleep: the oldest reader makes room
	m.mu.Lock()
	m.alive = func(string) bool { return false }
	m.mu.Unlock()
	_, ok, _ = m.ReadHistory(context.Background(), "a-3", "")
	require.True(t, ok)
	assert.Equal(t, 2, readers(m), "never more than the cap")
	m.mu.Lock()
	_, a1 := m.servers["a-1"]
	m.mu.Unlock()
	assert.False(t, a1, "the oldest one was stopped")
}

// A launch (a wake) does not run on a server that was started only to read: it replaces it, with the agent's own model.
func TestAWakeReplacesTheReaderServerOfItsAgent(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	noteAgentSession(cfg.DataDir, "agent-1", "ses_abc123")
	_, ok, _ := m.ReadHistory(context.Background(), "agent-1", "")
	require.True(t, ok)
	m.mu.Lock()
	reader := m.servers["agent-1"].srv
	m.mu.Unlock()

	woken, err := m.Ensure(context.Background(), "agent-1", "", "openai/gpt-6", "ses_abc123")
	require.NoError(t, err)
	assert.NotSame(t, reader, woken, "not the reader's server")
	select {
	case <-reader.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the reader's server was left running")
	}
	assert.Zero(t, readers(m), "the agent's own server is not a reader")
	again, err := m.Ensure(context.Background(), "agent-1", "", "openai/gpt-6", "ses_abc123")
	require.NoError(t, err)
	assert.Same(t, woken, again)
}

func TestAFailedReaderStartIsNotTriedAgainForAWhile(t *testing.T) {
	cfg, _ := stubConfig(t)
	cfg.Bin = "/no/such/opencode"
	m := NewManager(cfg)
	defer m.Close()
	noteAgentSession(cfg.DataDir, "agent-1", "ses_abc123")
	_, ok, err := m.ReadHistory(context.Background(), "agent-1", "")
	require.NoError(t, err, "an empty chat, not an error")
	assert.False(t, ok)
	m.mu.Lock()
	first := m.readFail["agent-1"]
	m.mu.Unlock()
	require.False(t, first.IsZero(), "the failure is noted")
	_, ok, _ = m.ReadHistory(context.Background(), "agent-1", "")
	assert.False(t, ok)
	m.mu.Lock()
	second := m.readFail["agent-1"]
	m.mu.Unlock()
	assert.Equal(t, first, second, "not tried again inside the cooldown (a chat polls every second)")
}

// Anyone who may open a sleeping agent's chat can cause a reader to start: the STARTS are bounded, not only the readers that run (Security's SHOULD 3 on ede47c4f9).
func TestTwentyOpensOfTwentySleepingAgentsInASecondStartNoMoreThanTheGapsAllow(t *testing.T) {
	cfg, envFile := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	for i := 0; i < 20; i++ {
		noteAgentSession(cfg.DataDir, fmt.Sprintf("sleeper-%02d", i), "ses_abc123")
	}
	var served int
	for i := 0; i < 20; i++ {
		if _, ok, _ := m.ReadHistory(context.Background(), fmt.Sprintf("sleeper-%02d", i), ""); ok {
			served++
		}
	}
	assert.Equal(t, 1, served, "one start per 5 s across the manager: the first open is served, the rest get the empty chat")
	assert.Equal(t, 1, readers(m))
	raw, err := os.ReadFile(envFile + ".pids")
	require.NoError(t, err)
	assert.Len(t, strings.Fields(string(raw)), 1, "one process was started, not twenty")

	// the same agent again: inside its own gap nothing is started either, even with the manager's gap passed
	readerStartGap = 0
	defer func() { readerStartGap = 5 * time.Second }()
	m.Stop("sleeper-00")
	_, ok, _ := m.ReadHistory(context.Background(), "sleeper-00", "")
	assert.False(t, ok, "one start per agent per 60 s")
}

// Two opens at once must not both pass the count: a reader being started counts against the cap (Security's INFO 4).
func TestReadersBeingStartedCountAgainstTheCap(t *testing.T) {
	noStartGaps(t)
	cfg, envFile := stubConfig(t)
	t.Setenv(listenDelayVar, "600") // each start takes a moment: the opens overlap
	m := NewManager(cfg)
	defer m.Close()
	m.alive = func(string) bool { return true } // no agent gives up its server
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		key := fmt.Sprintf("racer-%d", i)
		noteAgentSession(cfg.DataDir, key, "ses_abc123")
		wg.Add(1)
		go func() { defer wg.Done(); m.ReadHistory(context.Background(), key, "") }()
	}
	wg.Wait()
	assert.LessOrEqual(t, readers(m), readerCap)
	raw, _ := os.ReadFile(envFile + ".pids")
	assert.LessOrEqual(t, len(strings.Fields(string(raw))), readerCap, "no more than the cap were ever started")
}

// A reader stops itself after readerIdle without a read, and a read keeps it.
func TestAReaderStopsItselfWhenNobodyReadsIt(t *testing.T) {
	noStartGaps(t)
	old := readerIdle
	readerIdle = 400 * time.Millisecond
	defer func() { readerIdle = old }()
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	noteAgentSession(cfg.DataDir, "agent-1", "ses_abc123")
	_, ok, _ := m.ReadHistory(context.Background(), "agent-1", "")
	require.True(t, ok)
	for i := 0; i < 4; i++ { // read every 200 ms: it is kept past the idle time
		time.Sleep(200 * time.Millisecond)
		_, ok, _ = m.ReadHistory(context.Background(), "agent-1", "")
		require.True(t, ok)
		require.Equal(t, 1, readers(m))
	}
	waitFor(t, "the idle reader to stop itself", func() bool { return readers(m) == 0 })
}
