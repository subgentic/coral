package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #16523 (the Operator's #16519 on v2.0.68): Shift+Tab inside Claude changes the live mode and Coral kept the stored launch mode, so Reset team relaunched in the old one. Claude writes
// permissionMode on its user entries; the team starts again in the mode its transcript last recorded, when that entry is newer than the run's start, and never in a mode that asks less
// than the launch allowed (bypassPermissions only when the stored launch already allowed it).
func TestResetTeamKeepsTheModeShiftTabSet(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	projects := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", projects)
	type entry struct {
		mode string
		at   time.Duration // from now: positive is after the launch, negative before it
	}
	for _, tc := range []struct {
		name    string
		stored  string
		extra   []string // more launch flags
		entries []entry
		want    string
	}{
		{"Shift+Tab to default after an auto launch", "auto", nil, []entry{{"auto", -time.Hour}, {"default", time.Hour}}, "default"},
		{"Shift+Tab to plan, the newest entry wins", "auto", nil, []entry{{"default", time.Hour}, {"plan", 2 * time.Hour}}, "plan"},
		{"an entry older than the launch is not the live mode (a Restart with changes since)", "auto", nil, []entry{{"plan", -time.Hour}}, "auto"},
		{"no entry keeps the stored mode", "auto", nil, nil, "auto"},
		{"a value nobody can read keeps the stored mode", "auto", nil, []entry{{"yolo", time.Hour}}, "auto"},
		{"bypass is not taken when the launch did not allow it", "auto", nil, []entry{{"bypassPermissions", time.Hour}}, "auto"},
		{"bypass is kept when the launch was bypass", "bypassPermissions", nil, []entry{{"bypassPermissions", time.Hour}}, "bypassPermissions"},
		{"bypass is taken when the launch allowed it (--allow-dangerously-skip-permissions)", "auto", []string{"--allow-dangerously-skip-permissions"}, []entry{{"bypassPermissions", time.Hour}}, "bypassPermissions"},
		{"Shift+Tab out of bypass is kept", "bypassPermissions", nil, []entry{{"plan", time.Hour}}, "plan"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			board := fmt.Sprintf("shifttab%d", len(tc.name))
			work := t.TempDir()
			agents := []map[string]any{{"name": "A", "agent_type": "claude", "flags": append([]string{"--permission-mode", tc.stored}, tc.extra...)}} // a member's mode is sent as the CLI's own flags
			body, _ := json.Marshal(map[string]any{"board_name": board, "new_board": true, "working_dir": work, "agent_type": at.Claude, "agents": agents})
			rec := httptest.NewRecorder()
			h.LaunchTeam(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body)))
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var launched struct {
				Board  string           `json:"board"`
				Agents []map[string]any `json:"agents"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &launched))
			require.Len(t, launched.Agents, 1, rec.Body.String())
			first, _ := launched.Agents[0]["session_id"].(string)
			ls, err := ss.GetLiveSession(ctx, first)
			require.NoError(t, err)
			require.NotNil(t, ls.PermissionMode)
			require.Equal(t, tc.stored, *ls.PermissionMode, "launched in")

			if len(tc.entries) > 0 { // Claude's own file for the session: user entries carrying the mode the terminal was in
				dir := filepath.Join(projects, transcriptlink.ClaudeProjectDirName(work))
				require.NoError(t, os.MkdirAll(dir, 0o755))
				var lines bytes.Buffer
				for i, e := range tc.entries {
					fmt.Fprintf(&lines, `{"type":"user","permissionMode":%q,"timestamp":%q,"message":{"role":"user","content":"turn %d"}}`+"\n", e.mode, time.Now().Add(e.at).UTC().Format(time.RFC3339Nano), i)
				}
				require.NoError(t, os.WriteFile(filepath.Join(dir, first+".jsonl"), lines.Bytes(), 0o644))
			}

			rr := httptest.NewRecorder()
			h.ResetTeam(rr, dropAt2(httptest.NewRequest(http.MethodPost, "/reset", nil), map[string]string{"boardName": launched.Board}))
			require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
			var reset struct {
				Agents []map[string]any `json:"agents"`
			}
			require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &reset), rr.Body.String())
			require.Len(t, reset.Agents, 1, rr.Body.String())
			again, _ := reset.Agents[0]["session_id"].(string)
			require.NotEmpty(t, again, rr.Body.String())
			now, err := ss.GetLiveSession(ctx, again)
			require.NoError(t, err)
			require.NotNil(t, now.PermissionMode)
			assert.Equal(t, tc.want, *now.PermissionMode, "after the reset")
		})
	}
}
