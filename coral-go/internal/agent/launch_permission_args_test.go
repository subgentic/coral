package agent

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// #15719: the New agent dialog shows these arguments, read off the launch builders themselves.
func TestLaunchPermissionArgsAreWhatTheLaunchBuildersAdd(t *testing.T) {
	for _, tc := range []struct {
		agent, mode string
		full        bool
		want        string
	}{
		{"codex", "", false, ""},
		{"codex", "default", false, ""},
		{"codex", "plan", false, "--sandbox read-only -a on-request"},
		{"codex", "auto", false, "-c sandbox_workspace_write.network_access=true --sandbox workspace-write -a never"},
		{"codex", "bypassPermissions", false, "--dangerously-bypass-approvals-and-sandbox"},
		{"codex", "plan", true, "--dangerously-bypass-approvals-and-sandbox"},
		{"claude", "plan", false, "--permission-mode plan"},
		{"claude", "bypassPermissions", false, "--permission-mode bypassPermissions"},
		{"hermes", "bypassPermissions", false, "--yolo"},
		{"pi", "bypassPermissions", false, ""},
	} {
		t.Run(tc.agent+"/"+tc.mode+map[bool]string{true: "/full"}[tc.full], func(t *testing.T) {
			got, err := LaunchPermissionArgs(tc.agent, LaunchParams{PermissionMode: tc.mode, KeepFullAccess: tc.full})
			require.NoError(t, err)
			require.Equal(t, tc.want, strings.Join(got, " "))
		})
	}
}

func TestLaunchPermissionArgsLeaveNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, SetTempDir(dir))
	t.Cleanup(func() { _ = SetTempDir(t.TempDir()) })
	_, err := LaunchPermissionArgs("codex", LaunchParams{PermissionMode: "plan"})
	require.NoError(t, err)
	left, _ := filepathGlobAll(dir)
	require.Empty(t, left)
}

func filepathGlobAll(dir string) ([]string, error) {
	es, err := os.ReadDir(dir)
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out, err
}
