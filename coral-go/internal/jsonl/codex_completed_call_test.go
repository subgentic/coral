package jsonl

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestCodexCompletedCall7896Captured(t *testing.T) {
	raw, err := os.ReadFile("testdata/codex_permission_7896/approved-background.jsonl")
	require.NoError(t, err)
	var state codexTurnCache
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		updateCodexTurnState(&state, []byte(line))
	}
	require.False(t, state.calls.invalid)
	require.Len(t, state.calls.completed, 1, "tracker: %+v", state.calls)
	require.Equal(t, time.Date(2026, 10, 26, 6, 26, 1, 859000000, time.UTC), state.calls.completed[0].end)
}

func TestCodexCompletedCall7896Ambiguity(t *testing.T) {
	raw, err := os.ReadFile("testdata/codex_permission_7896/approved-background.jsonl")
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	parallel := `{"timestamp":"2026-10-26T06:25:35.200Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"parallel","name":"exec"}}`
	for _, tc := range []struct {
		name  string
		lines []string
	}{
		{"parallel outer call", []string{lines[0], lines[1], parallel, lines[2]}},
		{"parallel result first still ambiguous", []string{lines[0], lines[1], parallel, strings.ReplaceAll(lines[2], "outer-call-7896", "parallel"), lines[2]}},
		{"another call result", []string{lines[0], lines[1], strings.ReplaceAll(lines[2], "outer-call-7896", "unrelated")}},
		{"unknown output followed by valid output", []string{lines[0], lines[1], strings.ReplaceAll(lines[2], "outer-call-7896", "unrelated"), lines[2]}},
		{"missing call ID", []string{lines[0], strings.ReplaceAll(lines[1], "outer-call-7896", ""), lines[2]}},
		{"outer script yields while approval can be pending", []string{lines[0], lines[1], strings.ReplaceAll(lines[2], "Script completed", "Script running with cell ID 12")}},
		{"a tool prints the harness words", []string{lines[0], strings.ReplaceAll(lines[1], `"name": "exec"`, `"name": "other"`), lines[2]}},
		{"new turn drops prior correlation", []string{lines[0], lines[1], lines[0], lines[2]}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var state codexTurnCache
			for _, line := range tc.lines {
				updateCodexTurnState(&state, []byte(line))
			}
			require.Empty(t, state.calls.completed, "ambiguous evidence must never release held input")
		})
	}
}

func TestCodexCompletedCall7896LongTurnAndReplacement(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	sid := uuid.NewString()
	dir := filepath.Join(home, "sessions", "2026", "10", "26")
	require.NoError(t, os.MkdirAll(dir, 0700))
	path := filepath.Join(dir, "rollout-"+sid+".jsonl")
	raw, err := os.ReadFile("testdata/codex_permission_7896/approved-background.jsonl")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, raw, 0600))
	request := time.Date(2026, 10, 26, 6, 25, 35, 324373000, time.UTC)
	r := NewSessionReader()
	completed := r.ReadCodexCompletedCall(sid, "", request)
	require.False(t, completed.IsZero())
	// Later calls must not evict a proved resolution and put the row back at Permission.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	require.NoError(t, err)
	for i := 0; i < 40; i++ {
		_, err = fmt.Fprintf(f, "{\"timestamp\":\"2026-10-26T06:27:%02d.100Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"exec\",\"call_id\":\"later-%d\"}}\n{\"timestamp\":\"2026-10-26T06:27:%02d.200Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"later-%d\",\"output\":[{\"type\":\"input_text\",\"text\":\"Script completed\\n\"}]}}\n", i, i, i, i)
		require.NoError(t, err)
	}
	require.NoError(t, f.Close())
	require.Equal(t, completed, r.ReadCodexCompletedCall(sid, "", request))
	c := r.getOrCreateSessionCache(sid)
	require.Len(t, c.codexState.calls.completed, 32)
	// Replacement/truncation invalidates the proof; no stale cache may release input.
	require.NoError(t, os.WriteFile(path, []byte("{}\n"), 0600))
	require.True(t, r.ReadCodexCompletedCall(sid, "", request).IsZero())
}
