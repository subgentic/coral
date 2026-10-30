package background

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// #11293 (row 12): a scheduled job on Pi ran Pi interactive with its session kept and no --print, so Pi stayed open at its prompt and the run ended killed at its maximum duration. A Pi job
// is one shot: `pi --print --no-session --no-approve ... <prompt>`, the job's prompt as the argument (not typed afterwards), so Pi answers and exits and the run ends with it.
func TestAPiJobRunsOneShotWithItsPromptOnTheCommandLine(t *testing.T) {
	rt := &spawnRecorder{}
	l := NewAgentLauncher(rt, store.NewSessionStore(setupTestDB(t)), 8450)
	job := store.ScheduledJob{AgentType: at.Pi, Name: "nightly", RepoPath: t.TempDir(), Prompt: "summarize the open tasks"}
	_, err := l.launchAgent(context.Background(), job.RepoPath, job.AgentType, job.Name, "", jobLaunchFlags(job), true, job.Prompt, "", "", oneShotJob(job.AgentType))
	require.NoError(t, err)
	rt.mu.Lock()
	defer rt.mu.Unlock()
	require.Len(t, rt.commands, 1)
	cmd := rt.commands[0]
	assert.Contains(t, cmd, "--print", cmd)
	assert.Contains(t, cmd, "--no-session", cmd)
	assert.Contains(t, cmd, "--no-approve", cmd)
	assert.NotContains(t, cmd, "--continue", cmd)
	assert.Contains(t, cmd, "pi_prompt", "the prompt is the command's argument (a prompt file), not typed after the start")
}

func TestOnlyPiJobsAreOneShot(t *testing.T) {
	assert.True(t, oneShotJob(at.Pi))
	for _, other := range []string{at.Claude, at.Codex, at.Gemini, at.Agy, at.Terminal} {
		assert.False(t, oneShotJob(other), other)
	}
}

func TestAJobOnClaudeIsNotLaunchedOneShot(t *testing.T) {
	rt := &spawnRecorder{}
	l := NewAgentLauncher(rt, store.NewSessionStore(setupTestDB(t)), 8450)
	_, err := l.LaunchAgent(context.Background(), t.TempDir(), at.Claude, "job", "", nil, true, "p", "", "")
	require.NoError(t, err)
	rt.mu.Lock()
	defer rt.mu.Unlock()
	assert.False(t, strings.Contains(rt.commands[0], "--no-session"), rt.commands[0])
}
