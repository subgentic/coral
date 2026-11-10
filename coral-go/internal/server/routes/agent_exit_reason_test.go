package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15062: an exit notice says why in a few words, and the same stop is said once.

func (r *exitRig) screen(text string) {
	r.h.terminal = &loginScreenTerminal{mockSessionTerminal: newMockTerminal(), screen: text}
}

func (r *exitRig) flush() {
	for _, tm := range r.takeTimers() {
		tm.f()
	}
}

func (r *exitRig) setLaunched(id string, at time.Time) {
	_, err := r.h.db.ExecContext(context.Background(), "UPDATE live_sessions SET launched_at = ? WHERE session_id = ?", at.UTC().Format("2006-01-02T15:04:05.000000+00:00"), id)
	require.NoError(r.t, err)
}

func TestAnExitNoticeSaysWhyFromTheTerminalsLastErrorLine(t *testing.T) {
	r := newExitRig(t)
	r.screen("some output\nError: spawn ENOMEM at node:internal  token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD\nchris@host coral-go % \n")
	id := r.agent(1, "Hermes Agent Investigation", "")
	r.setLaunched(id, time.Now().Add(-3*time.Hour))
	r.h.AgentsSlept(context.Background(), []string{id})
	r.flush()
	n := strings.Join(r.notices(), "\n")
	assert.Contains(t, n, `Hermes Agent Investigation: exited, its last line was "Error: spawn ENOMEM`)
	assert.NotContains(t, n, "sk-ant", "the CLI's own line is redacted")
	assert.NotContains(t, n, "chris@host", "the prompt is not a reason")
}

func TestAnExitNoticeWithNothingOnScreenStillSaysWhatWasSeen(t *testing.T) {
	r := newExitRig(t)
	r.screen("chris@host coral-go % \n")
	id := r.agent(1, "Worker", "")
	r.setLaunched(id, time.Now().Add(-3*time.Hour))
	r.h.AgentsSlept(context.Background(), []string{id})
	r.flush()
	assert.Contains(t, strings.Join(r.notices(), "\n"), "Worker: exited, its CLI ended and left its terminal at a shell, with no error shown.")
}

func TestTheSameStopOfTheSameStartIsSaidOnce(t *testing.T) {
	r := newExitRig(t)
	r.screen("Error: boom\n$ \n")
	id := r.agent(1, "Hermes", "")
	r.setLaunched(id, time.Now().Add(-3*time.Hour))
	r.h.AgentsSlept(context.Background(), []string{id})
	r.flush()
	require.Len(t, r.notices(), 1)
	// A restart of Coral woke it with no new start, and the reconciler found the CLI gone again.
	r.die(id)
	r.h.AgentsSlept(context.Background(), []string{id})
	r.flush()
	assert.Len(t, r.notices(), 1, "no second notice for the same stop")
}

func TestAnAgentThatExitsRightAfterEachStartIsSaidOnce(t *testing.T) {
	r := newExitRig(t)
	r.screen("Error: boom\n$ \n")
	id := r.agent(1, "Crashy", "")
	for i := 0; i < 3; i++ {
		r.setLaunched(id, time.Now().Add(-30*time.Second).Add(time.Duration(i)*time.Millisecond)) // a new start each time
		r.die(id)
		r.h.AgentsSlept(context.Background(), []string{id})
		r.flush()
	}
	n := r.notices()
	require.Len(t, n, 1, fmt.Sprint(n))
	assert.Contains(t, n[0], `Crashy: exits right after it starts: its last line was "Error: boom".`)
}

func TestARestartedAgentThatRunsALongTimeIsNoticedAgain(t *testing.T) {
	r := newExitRig(t)
	r.screen("Error: boom\n$ \n")
	id := r.agent(1, "Steady", "")
	r.setLaunched(id, time.Now().Add(-5*time.Hour))
	r.h.AgentsSlept(context.Background(), []string{id})
	r.flush()
	r.setLaunched(id, time.Now().Add(-2*time.Hour)) // woken, ran two hours, exited
	r.die(id)
	r.h.AgentsSlept(context.Background(), []string{id})
	r.flush()
	assert.Len(t, r.notices(), 2, "a fresh start that ran long and stopped is news")
}

func TestLastErrorLineIsShortRedactedAndOneLine(t *testing.T) {
	assert.Equal(t, "", lastErrorLine("all fine\n$ \n"))
	long := "Error: " + strings.Repeat("x", 500)
	assert.LessOrEqual(t, len(lastErrorLine(long)), exitReasonMax)
	assert.Equal(t, "zsh: killed coral", lastErrorLine("\x1b\x07zsh:   killed   coral\n"))
}

// A program's output can say "@Orchestrator": the notice never mentions anyone (QA's probe on #15062).
func TestAnAtSignInTheTerminalsLastLineNeverMentionsAnyone(t *testing.T) {
	assert.Equal(t, "Error: ask Orchestrator and all to run this", lastErrorLine("Error: ask @Orchestrator and @all to run this\n$ \n"))
	r := newExitRig(t)
	r.screen("Error: ask @Orchestrator and @all to run this\n$ \n")
	id := r.agent(1, "Worker", "")
	r.setLaunched(id, time.Now().Add(-3*time.Hour))
	r.h.AgentsSlept(context.Background(), []string{id})
	r.flush()
	n := strings.Join(r.notices(), "\n")
	assert.Contains(t, n, `Worker: exited, its last line was "Error: ask Orchestrator and all to run this"`)
	assert.NotContains(t, n, "@")
}
