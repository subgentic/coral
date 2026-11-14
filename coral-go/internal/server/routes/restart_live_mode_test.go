package routes

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #16536 (the same rule as Reset team, #16523): "Restart, same settings" starts a Claude agent in the mode Shift+Tab set inside it (its transcript's newest permissionMode, when newer than the
// run's start), never in a bypass the launch did not allow, and a mode picked in the restart dialog wins over it.
func TestRestartKeepsTheModeShiftTabSet(t *testing.T) {
	srv, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	projects := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", projects)
	for _, tc := range []struct {
		name       string
		stored     string
		entryMode  string
		entryAt    time.Duration // from now: positive is after the launch
		pick       string        // the mode named in the restart dialog
		want       string        // the --permission-mode value on the command
		notPresent string
	}{
		{"Shift+Tab to plan", "auto", "plan", time.Hour, "", "plan", "--permission-mode auto"},
		{"Shift+Tab to default", "auto", "default", time.Hour, "", "default", "--permission-mode auto"},
		{"an entry older than the launch is not the live mode", "auto", "plan", -time.Hour, "", "auto", "--permission-mode plan"},
		{"no entry keeps the stored mode", "auto", "", 0, "", "auto", "--permission-mode plan"},
		{"bypass is not taken when the launch did not allow it", "auto", "bypassPermissions", time.Hour, "", "auto", "bypassPermissions"},
		{"a mode picked in the dialog wins", "auto", "plan", time.Hour, "acceptEdits", "acceptEdits", "--permission-mode plan"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			work := t.TempDir()
			agents := []map[string]any{{"name": "A", "agent_type": "claude", "flags": []string{"--permission-mode", tc.stored}}}
			body, _ := json.Marshal(map[string]any{"board_name": fmt.Sprintf("rshift%d", len(tc.name)), "new_board": true, "working_dir": work, "agent_type": at.Claude, "agents": agents})
			rec := httptest.NewRecorder()
			h.LaunchTeam(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body)))
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var launched struct {
				Agents []map[string]any `json:"agents"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &launched))
			require.Len(t, launched.Agents, 1, rec.Body.String())
			sid, _ := launched.Agents[0]["session_id"].(string)
			name, _ := launched.Agents[0]["session_name"].(string)
			if tc.entryMode != "" {
				dir := filepath.Join(projects, transcriptlink.ClaudeProjectDirName(work))
				require.NoError(t, os.MkdirAll(dir, 0o755))
				line := fmt.Sprintf(`{"type":"user","permissionMode":%q,"timestamp":%q,"message":{"role":"user","content":"turn"}}`+"\n", tc.entryMode, time.Now().Add(tc.entryAt).UTC().Format(time.RFC3339Nano))
				require.NoError(t, os.WriteFile(filepath.Join(dir, sid+".jsonl"), []byte(line), 0o644))
			}
			req := map[string]any{"session_id": sid, "agent_type": "claude"}
			if tc.pick != "" {
				req["permission_mode"] = tc.pick
			}
			rb, _ := json.Marshal(req)
			resp, err := http.Post(srv.URL+"/api/sessions/live/"+name+"/restart", "application/json", bytes.NewReader(rb))
			require.NoError(t, err)
			resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			cmd := lastSentCommand(term)
			require.Contains(t, cmd, "--permission-mode "+tc.want, "the restart's command")
			require.NotContains(t, cmd, tc.notPresent, "the restart's command")
		})
	}
}
