package routes

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

type wakePinTerminal struct {
	*resumeTerm
	exited bool
}

func (w *wakePinTerminal) AgentShellIdle(context.Context, string, string, string) (bool, string, bool) {
	if w.exited {
		return true, "zsh", true
	}
	return false, "claude", true
}

type wakePinBackend struct {
	*resumeBackend
}

func (*wakePinBackend) IsRunning(string) bool { return false }

// Pin terminal operation order and the row/hook/settings effects. A failed start
// must leave the row asleep and must never claim that the CLI loaded its hooks.
func TestWakePinsLifecycleOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name, fail, backend, agentType, errorText string
		running, exited, launched                 bool
		ops                                       []string
		backendOps                                int
	}{
		{name: "new tmux", launched: true, ops: []string{"create", "log", "send"}},
		{name: "tmux create fails", fail: "create", errorText: "create session: create failed", ops: []string{"create"}},
		{name: "tmux logging failure is ignored", fail: "log", launched: true, ops: []string{"create", "log", "send"}},
		{name: "tmux send fails", fail: "send", errorText: "send failed", ops: []string{"create", "log", "send"}},
		{name: "running CLI stays alone", running: true},
		{name: "exited CLI resumes in its shell", running: true, exited: true, launched: true, ops: []string{"send"}},
		{name: "new pty", backend: "pty", launched: true, ops: []string{"send"}, backendOps: 1},
		{name: "pty spawn fails", backend: "pty", fail: "spawn", errorText: "resource temporarily unavailable", backendOps: 1},
		{name: "terminal agent is only marked awake", agentType: "terminal"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, h, mock, ss := setupSessionsTestServer(t)
			term := &wakePinTerminal{resumeTerm: &resumeTerm{mockSessionTerminal: mock, fail: map[string]bool{tc.fail: true}}, exited: tc.exited}
			h.terminal = term
			backend := &wakePinBackend{resumeBackend: &resumeBackend{spawnErr: tc.fail == "spawn"}}
			if tc.backend == "pty" {
				h.backend = backend
			}
			ctx := context.Background()
			const sid = "aaaaaaaa-8447-4000-8000-000000000001"
			agentType := tc.agentType
			if agentType == "" {
				agentType = "claude"
			}
			name := naming.SessionName(agentType, sid)
			dir := t.TempDir()
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "pin", AgentType: agentType, WorkingDir: dir, Backend: ptr.NonEmpty(tc.backend), DisplayName: ptr.NonEmpty("Pinned role")}))
			require.NoError(t, ss.SetSessionSleeping(ctx, sid, true))
			if tc.running {
				mock.addSession(name, dir)
			}
			ls, err := ss.GetLiveSession(ctx, sid)
			require.NoError(t, err)
			err = h.wakeExistingSession(ctx, ls)
			if tc.errorText != "" {
				require.ErrorContains(t, err, tc.errorText)
			} else {
				require.NoError(t, err)
			}
			var operations []string
			term.mu.Lock()
			for _, op := range term.ops {
				operations = append(operations, strings.Fields(op)[0])
			}
			term.mu.Unlock()
			require.Equal(t, tc.ops, operations)
			backend.mu.Lock()
			spawns := len(backend.ops)
			backend.mu.Unlock()
			require.Equal(t, tc.backendOps, spawns)
			row, err := ss.GetLiveSession(ctx, sid)
			require.NoError(t, err)
			wantSleeping := 0
			if tc.errorText != "" {
				wantSleeping = 1
			}
			require.Equal(t, wantSleeping, row.IsSleeping)
			_, stamped := ss.SessionSettingsStamp(ctx, sid)
			require.Equal(t, tc.launched, stamped)
			wantHooks := 0
			if tc.launched {
				wantHooks = agent.ClaudeHooksRev
			}
			require.Equal(t, wantHooks, hooksRevOf(t, ss, sid))
			if tc.launched {
				mock.mu.Lock()
				targets := make([]string, 0, len(mock.sent))
				for target := range mock.sent {
					targets = append(targets, target)
				}
				mock.mu.Unlock()
				target := name + ".0"
				if tc.backend == "pty" {
					target = name
				}
				require.Equal(t, []string{target}, targets)
			}
		})
	}
}
