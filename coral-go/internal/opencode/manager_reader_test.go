package opencode

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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
