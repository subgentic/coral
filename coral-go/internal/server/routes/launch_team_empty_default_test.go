package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// A team launch whose member has no mode, no flags and no capabilities starts the CLI in the new default (#14336, decision A/B: full permissions, inside each CLI's own sandbox): Claude in
// Auto, Codex in workspace-write with no approvals, never "no sandbox". A member that names Default (the form's explicit pick) stays in the CLI's confirm mode (#6415).
func TestATeamMemberWithNothingChosenSendsNoAutoFlags(t *testing.T) {
	for _, cli := range []string{at.Claude, at.Codex} {
		for _, explicit := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s explicit default=%v", cli, explicit), func(t *testing.T) {
				rig := setupAgyTestRig(t)
				fake := stubScript(t, filepath.Join(t.TempDir(), "mock-"+cli), "#!/bin/sh\nexit 0\n")
				require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(cli), fake))
				member := map[string]any{"name": "A"}
				if explicit {
					member["permission_mode"] = "default"
				}
				body, _ := json.Marshal(map[string]any{"board_name": "empty" + cli, "new_board": true, "working_dir": rig.workdir, "agent_type": cli, "agents": []map[string]any{member}})
				rec := httptest.NewRecorder()
				rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(body)))
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

				cmd := lastSentCommand(rig.term)
				require.Contains(t, cmd, fake, "the member's CLI was typed")
				for _, bad := range []string{"--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-skip-permissions", "bypassPermissions", "danger-full-access"} {
					assert.False(t, strings.Contains(cmd, bad), "%s: must not send %q: %s", cli, bad, cmd)
				}
				switch {
				case cli == at.Claude && !explicit:
					assert.Contains(t, cmd, "--permission-mode auto")
				case cli == at.Claude:
					assert.Contains(t, cmd, "--permission-mode default")
					assert.NotContains(t, cmd, "--permission-mode auto")
				case !explicit:
					assert.Contains(t, cmd, "--sandbox workspace-write -a never", "Codex stays in its sandbox")
				default:
					assert.NotContains(t, cmd, "-a never")
					assert.NotContains(t, cmd, "--sandbox workspace-write")
				}
			})
		}
	}
}
