package routes

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// registerLimitAgents registers agents (session id -> type), all awake, in /tmp/project, and returns the server's URL. At most eight, so the list is not a "large" one that leaves transcript reads out of a first paint.
func registerLimitAgents(t *testing.T, agents map[string]string) string {
	t.Helper()
	require.LessOrEqual(t, len(agents), 8)
	server, _, mock, ss := setupSessionsTestServer(t)
	for sid, typ := range agents {
		mock.addSession(naming.SessionName(typ, sid), "/tmp/project")
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentName: "a-" + sid[len(sid)-1:], AgentType: typ, WorkingDir: "/tmp/project"}))
	}
	return server.URL
}

func rfc(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// #20692, Claude: a live row of a Claude agent whose transcript ends in the CLI's rate-limit error carries blocked {kind: usage_limit, vendor: claude, reset_at}; reset_at is null when no time was printed,
// and a limit whose reset has come, or a transcript the agent has written past, has no mark.
func TestALiveRowOfAClaudeAgentStoppedByAUsageLimitSaysItsReset(t *testing.T) {
	projects := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", projects)
	const known, unix, none, passed, plain = "dddddddd-2092-4000-8000-000000000001", "dddddddd-2092-4000-8000-000000000002", "dddddddd-2092-4000-8000-000000000003", "dddddddd-2092-4000-8000-000000000004", "dddddddd-2092-4000-8000-000000000005"
	url := registerLimitAgents(t, map[string]string{known: "claude", unix: "claude", none: "claude", passed: "claude", plain: "claude"})
	dir := filepath.Join(projects, "-tmp-project")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	now := time.Now().UTC()
	errLine := func(text string) string {
		return fmt.Sprintf(`{"type":"assistant","isApiErrorMessage":true,"error":"rate_limit","timestamp":%q,"message":{"role":"assistant","content":[{"type":"text","text":%q}]}}`+"\n", now.Format(time.RFC3339Nano), text)
	}
	future := now.Add(3 * time.Hour).Truncate(time.Minute)
	for sid, text := range map[string]string{
		known:  "You've hit your limit · resets " + future.Format("3:04pm") + " (UTC)",
		unix:   fmt.Sprintf("Claude AI usage limit reached|%d", future.Unix()),
		none:   "Request rejected (429)",
		passed: fmt.Sprintf("Claude AI usage limit reached|%d", now.Add(-time.Hour).Unix()),
	} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, sid+".jsonl"), []byte(errLine(text)), 0o600))
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, plain+".jsonl"), []byte(errLine("Request rejected (429)")+`{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"`+now.Add(time.Second).Format(time.RFC3339Nano)+`"}`+"\n"), 0o600))

	rows := liveRows(t, url)
	assert.Equal(t, map[string]any{"kind": "usage_limit", "vendor": "claude", "reset_at": rfc(future)}, rows[known]["blocked"], "a clock time in the zone it printed")
	assert.Equal(t, map[string]any{"kind": "usage_limit", "vendor": "claude", "reset_at": rfc(future)}, rows[unix]["blocked"], "the older unix form")
	assert.Equal(t, map[string]any{"kind": "usage_limit", "vendor": "claude", "reset_at": nil}, rows[none]["blocked"], "limited, no time printed: null, never a guess")
	for _, sid := range []string{passed, plain} {
		_, has := rows[sid]["blocked"]
		assert.False(t, has, "row %s is not blocked", sid)
	}
}

// #20692, Codex and agy: their limits are read off the screen by the health monitor (NoteUsageLimit); the row says vendor and reset (null when the screen named none). A refused Codex model keeps its own kind, a sleeping agent is never marked,
// and a limit whose reset has come is over.
func TestALiveRowOfACodexOrAgyAgentStoppedByAUsageLimitSaysItsReset(t *testing.T) {
	const cTime, cNone, cRefused, cOver, aTime = "dddddddd-2092-4000-8000-000000000011", "dddddddd-2092-4000-8000-000000000012", "dddddddd-2092-4000-8000-000000000013", "dddddddd-2092-4000-8000-000000000014", "dddddddd-2092-4000-8000-000000000015"
	url := registerLimitAgents(t, map[string]string{cTime: "codex", cNone: "codex", cRefused: "codex", cOver: "codex", aTime: "agy"})
	now := time.Now()
	codexAt, agyAt := now.Add(26*time.Hour).Truncate(time.Second), now.Add(103*time.Hour).Truncate(time.Second)
	ptymanager.NoteUsageLimit(cTime, true, codexAt, now)
	ptymanager.NoteUsageLimit(cNone, true, time.Time{}, now)
	ptymanager.NoteUsageLimit(cRefused, true, codexAt, now)
	ptymanager.NoteCodexModelRefusal(cRefused, "gpt-6.1-sol", true, now)
	ptymanager.NoteUsageLimit(cOver, true, now.Add(-time.Minute), now.Add(-time.Hour))
	ptymanager.NoteUsageLimit(aTime, true, agyAt, now)
	t.Cleanup(func() {
		for _, sid := range []string{cTime, cNone, cRefused, cOver, aTime} {
			ptymanager.NoteUsageLimit(sid, false, time.Time{}, now)
			ptymanager.NoteCodexModelRefusal(sid, "", false, now)
		}
	})

	rows := liveRows(t, url)
	assert.Equal(t, map[string]any{"kind": "usage_limit", "vendor": "codex", "reset_at": rfc(codexAt)}, rows[cTime]["blocked"])
	assert.Equal(t, map[string]any{"kind": "usage_limit", "vendor": "codex", "reset_at": nil}, rows[cNone]["blocked"])
	assert.Equal(t, map[string]any{"kind": "usage_limit", "vendor": "agy", "reset_at": rfc(agyAt)}, rows[aTime]["blocked"])
	assert.Equal(t, map[string]any{"kind": "model_refused", "model": "gpt-6.1-sol"}, rows[cRefused]["blocked"], "a refused model keeps its own kind")
	_, has := rows[cOver]["blocked"]
	assert.False(t, has, "the reset has come: the limit is over")
}

func TestASleepingAgentIsNeverMarkedAsStoppedByAUsageLimit(t *testing.T) {
	const asleep = "dddddddd-2092-4000-8000-000000000021"
	server, _, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: asleep, AgentName: "zzz", AgentType: "codex", WorkingDir: "/tmp/project"}))
	require.NoError(t, ss.SetSessionSleepingFor(ctx, asleep, ""))
	ptymanager.NoteUsageLimit(asleep, true, time.Now().Add(time.Hour), time.Now())
	t.Cleanup(func() { ptymanager.NoteUsageLimit(asleep, false, time.Time{}, time.Now()) })
	_, has := liveRows(t, server.URL)[asleep]["blocked"]
	assert.False(t, has)
}
