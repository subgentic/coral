package background

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// limitTerminal is the one fake in the wiring test: a terminal that shows a screen and records what is typed. Everything else is real: SetAgents, the transcript reader, the task store, the delivery gate.
type limitTerminal struct {
	*fgReconRuntime
	mu     sync.Mutex
	screen string
	typed  []string
}

func (l *limitTerminal) AgentScreen(context.Context, string, string, string) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.screen, nil
}

func (l *limitTerminal) SendInput(_ context.Context, _ terminalinput.Origin, _, text string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.typed = append(l.typed, text)
	return nil
}

func (l *limitTerminal) show(s string) { l.mu.Lock(); l.screen = s; l.mu.Unlock() }
func (l *limitTerminal) typedNow() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.typed...)
}

const (
	limitIdleBox = "⏺ Done.\n\n──────────────────────────────────────────\n❯ \n──────────────────────────────────────────\n  ? for shortcuts\n"
	limitMenu    = " Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n\n Esc to cancel · Tab to amend\n"
)

// wiringRig is SetAgents on a Claude agent whose transcript ends in a real limit record (the scrubbed 5-hour record of internal/jsonl/testdata, its times moved to now) with the reset an hour away.
func wiringRig(t *testing.T, sid string) (*LimitResumer, *limitTerminal, func(time.Duration), *time.Time) {
	t.Helper()
	projects := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", projects)
	now := time.Date(2026, 11, 22, 20, 0, 0, 0, time.UTC)
	raw, err := os.ReadFile(filepath.Join("..", "jsonl", "testdata", "claude_limit_5h.jsonl"))
	require.NoError(t, err)
	var rec map[string]any
	require.NoError(t, json.Unmarshal(raw, &rec))
	rec["timestamp"] = now.Format(time.RFC3339Nano)
	rec["apiErrorParams"].(map[string]any)["rate_limit_info"].(map[string]any)["resetsAt"] = now.Add(time.Hour).Unix()
	line, err := json.Marshal(rec)
	require.NoError(t, err)
	dir := filepath.Join(projects, "-tmp-project")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dir, sid+".jsonl"), append(line, '\n'), 0o600))

	db := setupTestDB(t)
	ts := store.NewTaskStore(db)
	rt := &limitTerminal{fgReconRuntime: &fgReconRuntime{reconMockRuntime: reconMockRuntime{alive: map[string]bool{}}}, screen: limitIdleBox}
	name := naming.SessionName("claude", sid)
	rt.set(name, "node") // the agent's own CLI is the foreground program
	rt.alive[name] = true
	agents := []AgentInfo{{AgentType: "claude", SessionID: sid, WorkingDirectory: "/tmp/project"}}

	r := NewLimitResumer(0)
	clock := now
	r.now = func() time.Time { return clock }
	r.SetAgents(ts, rt, func(context.Context) ([]AgentInfo, error) { return agents, nil }, func(context.Context) bool { return true })
	t.Cleanup(func() { ptymanager.NoteLimitResume(sid, time.Time{}); ptymanager.ForgetSession(name) })
	return r, rt, func(d time.Duration) { clock = clock.Add(d); r.Tick(context.Background()) }, &clock
}

// #20697 (a): through SetAgents as the server wires it, a Claude agent that hit its limit gets the fixed notice once, after the reset, typed through the real delivery gate, and the pending time shows until then.
func TestSetAgentsResumesAClaudeAgentAfterItsRecordedReset(t *testing.T) {
	const sid = "dddddddd-2097-4000-8000-000000000001"
	_, rt, tick, _ := wiringRig(t, sid)
	tick(0)
	at, shown := ptymanager.LimitResumeAt(sid)
	require.True(t, shown, "the plan is in the session data")
	assert.WithinDuration(t, time.Date(2026, 11, 22, 21, 0, 0, 0, time.UTC), at, 2*time.Minute, "the reset the record names, plus a little spread")
	tick(30 * time.Minute)
	assert.Empty(t, rt.typedNow(), "nothing before the reset")
	tick(40 * time.Minute)
	assert.Equal(t, []string{limitResumeText}, rt.typedNow(), "the fixed notice, once")
	tick(time.Hour)
	assert.Len(t, rt.typedNow(), 1, "one resume per limit event")
	_, shown = ptymanager.LimitResumeAt(sid)
	assert.False(t, shown)
}

// #20697 (e): at the reset the real gate still refuses a screen that is at a menu or a prompt: nothing is typed, the agent's cap is not used, and the event is not typed into later when the menu is gone.
func TestSetAgentsTypesNothingIntoAMenuAtTheReset(t *testing.T) {
	const sid = "dddddddd-2097-4000-8000-000000000002"
	r, rt, tick, _ := wiringRig(t, sid)
	tick(0)
	rt.show(limitMenu)
	tick(70 * time.Minute)
	assert.Empty(t, rt.typedNow(), "a menu is open: nothing typed, no Enter")
	r.mu.Lock()
	used := len(r.sent[sid])
	r.mu.Unlock()
	assert.Zero(t, used, "not a resume, so it does not count")
	rt.show(limitIdleBox)
	tick(time.Hour)
	assert.Empty(t, rt.typedNow(), "the event is over: not typed into later")
}
