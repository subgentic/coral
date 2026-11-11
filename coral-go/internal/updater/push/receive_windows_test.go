//go:build windows

package push

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/secfile"
)

// #15572 (Security INFO on #15561): a Windows file has no 0600; the staged update is protected by the owner-only access list that
// verify.EnsureDir gives the staging folder and the staged folders and files inherit. TestReceiveRoundTrip skips its mode check there, so this
// proves the protection itself: the staging folder is put under one that grants Everyone Modify (as a shared data folder could be), and after a
// Receive nobody but this user can change the staging folder, the staged version folder or the package.
func TestReceiveStagedUpdateIsWritableByNoOtherUser(t *testing.T) {
	open := t.TempDir()
	ps := `$d = Get-Item -LiteralPath $env:D; $a = $d.GetAccessControl('Access'); ` +
		`$r = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')), 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'); ` +
		`$a.AddAccessRule($r); $d.SetAccessControl($a)`
	cmd := consoletest.HiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)
	cmd.Env = append(os.Environ(), "D="+open)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "%s", out)
	parent, err := secfile.Writers(open)
	require.NoError(t, err)
	require.Contains(t, parent, "Everyone", "the setup: the folder the staging folder is made in lets everyone write")

	root := filepath.Join(open, "staging")
	require.NoError(t, Receive(bytes.NewReader(stream(t, mkFiles(t, "1.2.3", []byte("package"), nil))), root, "1.2.3", testAsset, 1<<20))

	for name, p := range map[string]string{
		"the staging folder":       root,
		"the staged version":       filepath.Join(root, "1.2.3"),
		"the staged package":       filepath.Join(root, "1.2.3", testAsset),
		"the staged record":        filepath.Join(root, "1.2.3", "record.json"),
		"the staged signed sums":   filepath.Join(root, "1.2.3", "SHA256SUMS.txt"),
		"the staged signed record": filepath.Join(root, "1.2.3", "promote.json"),
	} {
		who, err := secfile.Writers(p)
		require.NoError(t, err, name)
		for _, w := range who {
			require.True(t, strings.HasPrefix(w, "this user"), "%s can be changed by %q (all: %v): the staged update is not private to this user", name, w, who)
		}
	}
}
