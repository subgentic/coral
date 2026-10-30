package background

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// #11293 (row 12): a scheduled job on Pi ran Pi interactive with its session kept and no --print, so Pi stayed open at its prompt and the run ended killed at its maximum duration. A Pi job
// is one shot: `pi --print --no-session --no-approve ... <prompt>`, the job's prompt as the argument (not typed afterwards), so Pi answers and exits and the run ends with it.
func TestAPiJobRunsOneShotWithItsPromptOnTheCommandLine(t *testing.T) {
	cliStubsOnPath(t, "pi") // the launch refuses a CLI it cannot find (#353); the stub stands in for it
	rt := &spawnRecorder{}
	l := newTestLauncher(t, rt, store.NewSessionStore(setupTestDB(t)), 8450)
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
	cliStubsOnPath(t, "claude") // the launch refuses a CLI it cannot find (#353); the stub stands in for it
	rt := &spawnRecorder{}
	l := newTestLauncher(t, rt, store.NewSessionStore(setupTestDB(t)), 8450)
	_, err := l.LaunchAgent(context.Background(), t.TempDir(), at.Claude, "job", "", nil, true, "p", "", "")
	require.NoError(t, err)
	rt.mu.Lock()
	defer rt.mu.Unlock()
	assert.False(t, strings.Contains(rt.commands[0], "--no-session"), rt.commands[0])
}

// Security's INFO on #11293: a one-shot job has its prompt on the command line and is not also typed it: Pi has exited (or is answering), and text typed into it would start a second turn. A Claude job
// is, as the control that the harness sees typed input.
func TestAOneShotJobIsNotAlsoTypedItsPrompt(t *testing.T) {
	cliStubsOnPath(t, "pi", "claude") // the launch refuses a CLI it cannot find (#353); the stub stands in for it
	old := promptInitialDelay
	promptInitialDelay = 10 * time.Millisecond
	t.Cleanup(func() { promptInitialDelay = old })
	run := func(agentType string) (typed int, command string) {
		rt := &spawnRecorder{}
		db := setupTestDB(t)
		ss := store.NewSessionStore(db)
		l := newTestLauncher(t, rt, ss, 8450)
		fn := l.BuildSchedulerLaunchFn(store.NewScheduleStore(db))
		ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
		defer cancel()
		_ = fn(ctx, store.ScheduledJob{AgentType: agentType, Name: "job", RepoPath: t.TempDir(), Prompt: "summarize the open tasks"}, 1)
		rt.mu.Lock()
		defer rt.mu.Unlock()
		if len(rt.commands) > 0 {
			command = rt.commands[0]
		}
		return len(rt.sent), command
	}
	typed, cmd := run(at.Pi)
	assert.Zero(t, typed, "nothing is typed into a one-shot Pi")
	assert.Contains(t, cmd, "--no-approve")
	typedClaude, _ := run(at.Claude)
	assert.NotZero(t, typedClaude, "control: an interactive job's prompt is typed")
}
