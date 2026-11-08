package routes

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// #14741 end to end through the team launch: an agy, Antigravity or Gemini member that names no mode starts in Auto, and its line carries agy's own --mode auto when that CLI's --help lists it and no mode flag
// when it does not; in neither case a skip flag. The row records Auto.
func TestAnAgyTeamMemberThatNamesNoModeStartsInAutoWhenItsCLIListsIt(t *testing.T) {
	const help = "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\ncat <<'EOF'\nUsage of agy:\n  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting\n  --mode                          Set the agent execution mode for this session (accept-edits, auto, plan)\nEOF\nexit 0\nfi\nexit 0\n"
	for _, cli := range []string{at.Agy, at.Antigravity, at.Gemini} {
		t.Run(cli, func(t *testing.T) {
			rig := setupAgyTestRig(t)
			fake := stubScript(t, filepath.Join(t.TempDir(), "mock-"+cli), help)
			require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(cli), fake))
			code, out, _ := teamOf(t, rig, cli, "auto-"+cli, map[string]any{"name": "A"}, nil)
			require.Equal(t, http.StatusOK, code, out)
			cmd := ""
			for _, sent := range rig.term.sentCommands() {
				if strings.Contains(sent, fake) {
					cmd = sent
				}
			}
			require.NotEmpty(t, cmd, "the launch line")
			assert.Contains(t, cmd, "--mode auto", cli)
			assert.NotContains(t, cmd, "--dangerously-skip-permissions", cli)
			assert.NotContains(t, cmd, "--yolo", cli)
		})
	}
}
