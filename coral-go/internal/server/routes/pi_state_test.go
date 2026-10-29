package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/store"
)

// #11091 (row 2 of the Pi gap table): a Pi agent's dot and "your turn" come from its session file. No hooks reach Coral from Pi, so before this a Pi agent's state was always unknown.
func TestPiSessionFileGivesTheAgentsState(t *testing.T) {
	sid := "3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a99"
	dir := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dir)
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(dir, "no-pi-home"))
	sd := filepath.Join(dir, "pi-sessions", sid)
	require.NoError(t, os.MkdirAll(sd, 0o700))
	file := filepath.Join(sd, "2026-10-29T10-00-00-000Z_01a18931-58c2-74fc-8a74-bed622970705.jsonl")
	n := 0
	add := func(line string) {
		f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		require.NoError(t, err)
		defer f.Close()
		_, err = f.WriteString(line + "\n")
		require.NoError(t, err)
		n++
	}
	ts := func() string { return fmt.Sprintf("2026-10-29T10:%02d:00.000Z", n) }
	add(`{"type":"session","version":3,"id":"00000000-0000-4000-8000-0000000000f1","timestamp":"2026-10-29T10:00:00.000Z","cwd":"/work"}`)
	h := &SessionsHandler{jsonl: jsonl.NewSessionReader()}
	state := func() SessionState {
		in := SessionStateInput{}
		h.applyTranscriptState(&in, nil, at.Pi, "pi-"+sid, sid, "/work")
		return DeriveSessionState(in)
	}

	add(fmt.Sprintf(`{"type":"message","id":"u1","parentId":null,"timestamp":%q,"message":{"role":"user","content":"go","timestamp":1}}`, ts()))
	assert.True(t, state().Working, "a prompt was sent: working")

	add(fmt.Sprintf(`{"type":"message","id":"a1","parentId":null,"timestamp":%q,"message":{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"bash","arguments":{"command":"ls"}}],"model":"m","stopReason":"toolUse"}}`, ts()))
	assert.True(t, state().Working, "a tool call in flight: still working")

	add(fmt.Sprintf(`{"type":"message","id":"a2","parentId":null,"timestamp":%q,"message":{"role":"assistant","content":[{"type":"text","text":"done"}],"model":"m","stopReason":"stop"}}`, ts()))
	st := state()
	assert.False(t, st.Working, "the turn ended: idle")
	assert.True(t, st.AwaitingUser, "and it is the person's turn")
	assert.False(t, st.NeedsInput, "an idle Pi is not asking for permission")
}

// #11105 (row 11): the per-tool counts of a Pi agent come from its session file (it records no events): GET .../events/counts says how many times each tool was called, most first.
func TestEventCountsOfAPiAgentComeFromItsSessionFile(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	_ = h
	sid := "3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a77"
	dir := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dir)
	sd := filepath.Join(dir, "pi-sessions", sid)
	require.NoError(t, os.MkdirAll(sd, 0o700))
	call := func(names ...string) string {
		blocks := ""
		for i, n := range names {
			if i > 0 {
				blocks += ","
			}
			blocks += fmt.Sprintf(`{"type":"toolCall","id":"c%d","name":%q,"arguments":{}}`, i, n)
		}
		return `{"type":"message","id":"a","parentId":null,"timestamp":"2026-10-29T10:00:00.000Z","message":{"role":"assistant","content":[` + blocks + `],"stopReason":"toolUse"}}`
	}
	require.NoError(t, os.WriteFile(filepath.Join(sd, "2026-10-29T10-00-00-000Z_x.jsonl"), []byte(call("bash", "read", "bash")+"\n"+call("bash")+"\n"+call("write")+"\n"), 0o600))
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: at.Pi, AgentName: "pi-dev", WorkingDir: "/work"}))

	resp, err := http.Get(server.URL + "/api/sessions/live/pi-" + sid + "/event-counts?session_id=" + sid)
	require.NoError(t, err)
	defer resp.Body.Close()
	var counts []map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&counts))
	require.Len(t, counts, 3)
	assert.Equal(t, "bash", counts[0]["tool_name"])
	assert.EqualValues(t, 3, counts[0]["count"])
	assert.ElementsMatch(t, []string{"read", "write"}, []string{counts[1]["tool_name"].(string), counts[2]["tool_name"].(string)})
}
