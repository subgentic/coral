package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
)

// The health monitor's screen read is what the live list and the chat say a refusal from (#13486, #13518): a read that finds the refusal is remembered for the session (with the model, or "" when the name is not
// a safe one), and a read that finds none forgets it. Pinned through the reader the monitor uses, and the registry the list reads.
func TestAScreenReadThatFindsAModelRefusalReachesWhatTheLiveListReads(t *testing.T) {
	ctx := context.Background()
	old := limitScreenTTL
	limitScreenTTL = 0 // every ask reads the screen afresh
	t.Cleanup(func() { limitScreenTTL = old })
	rt := &liveScreenRT{AgentRuntime: &mockRuntime{}}
	read, _ := screenModelRefusedSized(rt)
	require.NotNil(t, read)
	const sid = "11111111-1518-4000-8000-0000000000f1"
	t.Cleanup(func() { ptymanager.NoteCodexModelRefusal(sid, "", false, time.Now()) })
	agent := AgentInfo{AgentType: "codex", SessionID: sid}

	_, seen := ptymanager.CodexModelRefusalOf(sid, time.Minute, time.Now())
	require.False(t, seen, "nothing is remembered before a read")

	rt.set(refusedScreen)
	model, ok := read(ctx, agent)
	require.True(t, ok)
	assert.Equal(t, "gpt-6.1-sol", model)
	got, seen := ptymanager.CodexModelRefusalOf(sid, time.Minute, time.Now())
	assert.True(t, seen, "the read that found the refusal reached the registry the live list reads")
	assert.Equal(t, "gpt-6.1-sol", got)

	rt.set("■ The 'bad name; rm -rf' model is not supported when using Codex.\n")
	model, ok = read(ctx, agent)
	require.True(t, ok, "an unsafe name is still a refusal")
	assert.Empty(t, model)
	got, seen = ptymanager.CodexModelRefusalOf(sid, time.Minute, time.Now())
	assert.True(t, seen)
	assert.Empty(t, got, "and is remembered with no name")

	rt.set(workingScreen)
	_, ok = read(ctx, agent)
	require.False(t, ok)
	_, seen = ptymanager.CodexModelRefusalOf(sid, time.Minute, time.Now())
	assert.False(t, seen, "a read that finds no refusal forgets it")
}

// Only Codex is looked at, and a cached ask does not note again: another agent type's read reaches nothing.
func TestAScreenReadOfAnotherAgentTypeNotesNothing(t *testing.T) {
	old := limitScreenTTL
	limitScreenTTL = 0
	t.Cleanup(func() { limitScreenTTL = old })
	rt := &liveScreenRT{AgentRuntime: &mockRuntime{}, screen: refusedScreen}
	read, _ := screenModelRefusedSized(rt)
	const sid = "11111111-1518-4000-8000-0000000000f2"
	t.Cleanup(func() { ptymanager.NoteCodexModelRefusal(sid, "", false, time.Now()) })
	_, ok := read(context.Background(), AgentInfo{AgentType: "claude", SessionID: sid})
	assert.False(t, ok)
	_, seen := ptymanager.CodexModelRefusalOf(sid, time.Minute, time.Now())
	assert.False(t, seen)
}
