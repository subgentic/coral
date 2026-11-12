package agent

import (
	"os"
	"regexp"
	"strings"
	"sync"
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
	usePrivateLaunchTempDir(t, dir) // restores the earlier folder when the test ends
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

// Security's #15726 MUST 2: a preview writes nothing outside the launch temp folder it removes again. Hermes prepares a home under the data dir and writes its first message there: a preview of it
// touches none of that.
func TestHermesPermissionPreviewWritesNothingUnderTheDataDir(t *testing.T) {
	data := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", data)
	got, err := LaunchPermissionArgs("hermes", LaunchParams{PermissionMode: "bypassPermissions", CoralDir: data, BoardName: "team", WorkingDir: t.TempDir()})
	require.NoError(t, err)
	require.Equal(t, []string{"--yolo"}, got)
	left, _ := filepathGlobAll(data)
	require.Empty(t, left, "nothing appears under the data dir")
}

// Every agent type, one preview: the launch temp folder is empty again (agy's hooks come in a folder, not a file).
func TestPermissionPreviewLeavesNothingInTheLaunchTempFolderForAnyAgent(t *testing.T) {
	for _, typ := range []string{"claude", "codex", "agy", "gemini", "hermes", "pi", "terminal"} {
		t.Run(typ, func(t *testing.T) {
			dir := t.TempDir()
			usePrivateLaunchTempDir(t, dir)
			_, _ = LaunchPermissionArgs(typ, LaunchParams{PermissionMode: "plan", WorkingDir: t.TempDir(), CoralDir: t.TempDir()})
			left, _ := filepathGlobAll(dir)
			require.Empty(t, left)
		})
	}
}

// Two previews at once never take each other's files: each has its own random id, and each still answers what it was asked.
func TestConcurrentPermissionPreviewsAreIndependent(t *testing.T) {
	dir := t.TempDir()
	usePrivateLaunchTempDir(t, dir)
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		mode, want := "plan", "--sandbox read-only -a on-request"
		if i%2 == 1 {
			mode, want = "bypassPermissions", "--dangerously-bypass-approvals-and-sandbox"
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := LaunchPermissionArgs("codex", LaunchParams{PermissionMode: mode})
			require.NoError(t, err)
			require.Equal(t, want, strings.Join(got, " "))
		}()
	}
	wg.Wait()
	left, _ := filepathGlobAll(dir)
	require.Empty(t, left)
	a, b := newPreviewSessionID(), newPreviewSessionID()
	require.NotEqual(t, a, b)
	require.Regexp(t, regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`), a)
}
