package testtemp

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// unixSocketMax is the shortest limit on a Unix socket's path among the systems the tests run on: 104 bytes on macOS (108 on Linux).
const unixSocketMax = 104

// The private temp folder leaves room for the Unix sockets tests make below it, such as a tmux server's in a folder of its own
// (the coral-go-team's dry run on #177: "File name too long" in internal/tmux on macOS). The path is built the way setup builds it,
// plus the deepest socket a test makes there, and a socket is really listened on at that path.
func TestAUnixSocketBelowThePrivateTempFitsTheLimit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sockets' path limit: macOS and Linux")
	}
	dir, err := os.MkdirTemp(privateBase(), "ct-")
	require.NoError(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })
	tmp := filepath.Join(dir, "tmp")
	require.NoError(t, os.MkdirAll(tmp, 0o700))
	sockDir, err := os.MkdirTemp(tmp, "cbt-") // as internal/tmux's tests make a socket folder
	require.NoError(t, err)
	sock := filepath.Join(sockDir, "tmux-1000", "default") // tmux's own socket name below its folder
	assert.Less(t, len(sock), unixSocketMax, "the socket path %q is %d bytes", sock, len(sock))
	require.NoError(t, os.MkdirAll(filepath.Dir(sock), 0o700))
	l, err := net.Listen("unix", sock)
	require.NoError(t, err, "a socket at %q (%d bytes)", sock, len(sock))
	l.Close()
	if fi, statErr := os.Stat("/tmp"); statErr == nil && fi.IsDir() {
		assert.Equal(t, "/tmp", privateBase(), "on Unix the private folder goes under /tmp, the shortest temp folder")
	}
}

// A test's own folder (t.TempDir) is below the private temp folder too. Go's testing makes it below GOTMPDIR when that is set
// (a run that sets TMP and GOTMPDIR together, as QA's do), so Use points GOTMPDIR there as well. Otherwise a check that a test's
// folder "is in the temp folder" (mock-agent's ready mode, agent's common-place lookup) is false (QA on the v2.0.5 merge, #399).
func TestATestsOwnFolderIsBelowThePrivateTemp(t *testing.T) {
	if os.Getenv(Marker) == "" {
		t.Skip("not in a private world (a helper child)")
	}
	tmp, err := filepath.EvalSymlinks(os.TempDir())
	require.NoError(t, err)
	own, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	rel, err := filepath.Rel(tmp, own)
	require.NoError(t, err)
	assert.False(t, rel == ".." || len(rel) > 2 && rel[:3] == ".."+string(filepath.Separator), "t.TempDir() %q is not below os.TempDir() %q", own, tmp)
	assert.Equal(t, os.TempDir(), os.Getenv("GOTMPDIR"), "GOTMPDIR is the private temp folder")
}
