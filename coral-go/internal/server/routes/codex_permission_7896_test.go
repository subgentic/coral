package routes

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// The captured outer exec returns a running shell session after approval, nearly
// 29 seconds before PostToolUse. Before that result there is no safe resolution
// signal: even the captured Working screen must not release a held message.
func TestCodexPermission7896RealSequence(t *testing.T) {
	server, h, terminal, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	sid := uuid.NewString()
	name := "codex-" + sid
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "approval-probe", AgentType: "codex", WorkingDir: "/isolated/work"}))
	terminal.addSession(name, "/isolated/work")
	dir := filepath.Join(home, "sessions", "2026", "10", "26")
	require.NoError(t, os.MkdirAll(dir, 0700))
	path := filepath.Join(dir, "rollout-"+sid+".jsonl")
	fixture := filepath.Join("..", "..", "jsonl", "testdata", "codex_permission_7896")
	raw, err := os.ReadFile(filepath.Join(fixture, "hooks.json"))
	require.NoError(t, err)
	var events []store.AgentEvent
	require.NoError(t, json.Unmarshal(raw, &events))
	for _, ev := range events {
		ev.SessionID = &sid
		ev.AgentName = "approval-probe"
		_, err = h.ts.InsertAgentEvent(ctx, &ev)
		require.NoError(t, err)
	}
	raw, err = os.ReadFile(filepath.Join(fixture, "approved-background.jsonl"))
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	require.Len(t, lines, 3)
	for _, step := range []struct {
		name, data string
		waiting    bool
	}{
		{"dialog open", strings.Join(lines[:2], "\n") + "\n", true},
		{"approved but no native result yet", strings.Join(lines[:2], "\n") + "\n" + `{"timestamp":"2026-10-26T06:26:00.857Z","type":"event_msg","payload":{"type":"item_completed"}}` + "\n", true},
		{"correlated completed outer call, shell still running", strings.Join(lines[:2], "\n") + "\n" + `{"timestamp":"2026-10-26T06:26:00.857Z","type":"event_msg","payload":{"type":"item_completed"}}` + "\n" + lines[2] + "\n", false},
	} {
		t.Run(step.name, func(t *testing.T) {
			require.NoError(t, os.WriteFile(path, []byte(step.data), 0600))
			httpState, wsState := httpAndWSState(t, server, h, sid)
			require.Equal(t, httpState, wsState)
			require.Equal(t, step.waiting, httpState["waiting_for_input"])
			require.Equal(t, !step.waiting, httpState["working"])
			single := h.deriveSingleSessionState(ctx, sid, 0)
			require.Equal(t, step.waiting, single.NeedsInput)
			gate, ok := h.gateState(ctx, name, "codex", sid)
			require.True(t, ok)
			want := ptymanager.StateInTurn
			if step.waiting {
				want = ptymanager.StateBlocked
			}
			require.Equal(t, want, gate.State)
		})
	}
}

func TestCodexPermission7896KeepsAmbiguousRequests(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	sid := uuid.NewString()
	dir := filepath.Join(home, "sessions", "2026", "10", "26")
	require.NoError(t, os.MkdirAll(dir, 0700))
	fixture := filepath.Join("..", "..", "jsonl", "testdata", "codex_permission_7896")
	raw, err := os.ReadFile(filepath.Join(fixture, "approved-background.jsonl"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "rollout-"+sid+".jsonl"), raw, 0600))
	raw, err = os.ReadFile(filepath.Join(fixture, "hooks.json"))
	require.NoError(t, err)
	var events []store.AgentEvent
	require.NoError(t, json.Unmarshal(raw, &events))
	request := events[1].StateEvent()
	cases := []struct {
		name   string
		events []StateEvent
	}{
		{"missing inner call IDs", []StateEvent{{Type: request.Type, Kind: request.Kind, ToolName: request.ToolName, At: request.At}}},
		{"parallel candidate inner calls", []StateEvent{{Type: request.Type, Kind: request.Kind, ToolName: request.ToolName, At: request.At, CallIDs: []string{"inner-call-7896", "another"}}}},
		{"multiple requests", []StateEvent{request, request}},
		{"question beside permission", []StateEvent{request, {Type: "permission_request", Kind: "question", At: request.At}}},
		{"notification asks for input", []StateEvent{request, {Type: "notification", Summary: "Claude needs your permission to use Bash", At: request.At}}},
		{"result belongs to an earlier request", []StateEvent{{Type: request.Type, Kind: request.Kind, ToolName: request.ToolName, At: request.At.Add(time.Minute), CallIDs: request.CallIDs}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := SessionStateInput{Events: tc.events}
			h.applyTranscriptState(&in, nil, "codex", "codex-"+sid, sid, "/isolated/work")
			require.True(t, DeriveSessionState(in).NeedsInput)
		})
	}
}
