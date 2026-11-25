package agent

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// CodexLaunchPermissions (#14051) is the sandbox and approval policy a Codex launch with these stored settings runs with, from the same flag builder a launch uses: what a wake or a restart
// would give the agent, to be compared with the mode it runs in now. Since #21335 a launch with nothing stored is Default, which is Auto: workspace-write and never.
func TestCodexLaunchPermissionsAreWhatTheLaunchBuilderGives(t *testing.T) {
	caps := func(raw string) *Capabilities {
		c := &Capabilities{}
		require.NoError(t, json.Unmarshal([]byte(raw), c))
		return c
	}
	narrow := caps(`{"allow":["file_read","file_write","web_access","shell:npm *","shell:npx *","shell:coral-board *"]}`)
	for _, tc := range []struct {
		name              string
		flags             []string
		caps              *Capabilities
		mode              string
		sandbox, approval string
	}{
		{"bypass flag, no capabilities", []string{"--dangerously-bypass-approvals-and-sandbox"}, nil, "", "danger-full-access", "never"},
		{"bypass mode, no capabilities", nil, nil, "bypassPermissions", "danger-full-access", "never"},
		{"the stored bypass is narrowed by capabilities (the three agents of #14028)", []string{"--dangerously-bypass-approvals-and-sandbox"}, narrow, "bypassPermissions", "workspace-write", "on-request"},
		{"capabilities and the default mode: Default is Auto, a narrow shell list no longer makes it ask (#21335, coral-hub's three agents)", nil, narrow, "default", "workspace-write", "never"},
		{"nothing stored: Default is Auto (#21335)", nil, nil, "", "workspace-write", "never"},
		{"default mode, no flags (#21335)", nil, nil, "default", "workspace-write", "never"},
		{"auto mode", nil, nil, "auto", "workspace-write", "never"},
		{"plan mode", nil, nil, "plan", "read-only", "on-request"},
		{"sandbox and approval flags", []string{"--sandbox", "read-only", "-a", "on-request"}, nil, "", "read-only", "on-request"},
		{"the old approval name is the one Codex takes", []string{"--sandbox=workspace-write", "--ask-for-approval", "untrusted"}, nil, "", "workspace-write", "on-request"},
		{"config overrides", []string{"-c", "sandbox_mode=danger-full-access", "-c", "approval_policy=never"}, nil, "", "danger-full-access", "never"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sandbox, approval := CodexLaunchPermissions(tc.flags, tc.caps, tc.mode, false)
			require.Equal(t, [2]string{tc.sandbox, tc.approval}, [2]string{sandbox, approval})
		})
	}
}
