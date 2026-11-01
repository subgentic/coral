package routes

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func touch(t *testing.T, path string) string {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte("x"), 0o755))
	return path
}

// Claude Code renames its running binary to <name>.old.<n>.<pid> when it updates itself: the bulk record still takes that process as the resolved CLI. Security's conditions (#6886): the CLI's own
// folder (links resolved on both sides), the exact anchored name with 1 to 20 digits each, a regular file, and no match for anything unreadable.
func TestASelfUpdatedImageIsTheCLIOnlyInTheExactShape(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "bin")
	cli := touch(t, filepath.Join(dir, "claude.exe"))
	yes := func(name string) {
		assert.True(t, isSelfUpdatedImage(touch(t, filepath.Join(dir, name)), cli), name)
	}
	no := func(why, image string) {
		assert.False(t, isSelfUpdatedImage(touch(t, image), cli), why)
	}
	yes("claude.exe.old.3.1234")
	yes("CLAUDE.EXE.OLD.12.99") // case-insensitive
	yes("claude.exe.old." + strings.Repeat("9", 20) + "." + strings.Repeat("1", 20))

	no("another folder", filepath.Join(root, "other", "claude.exe.old.3.1234"))
	no("a sibling folder with the same names", filepath.Join(root, "bin2", "claude.exe.old.3.1234"))
	no("a sub folder", filepath.Join(dir, "x", "claude.exe.old.3.1234"))
	no("another base name", filepath.Join(dir, "evil.exe.old.3.1234"))
	no("a name without the extension", filepath.Join(dir, "claude.old.3.1234"))
	no("no pid", filepath.Join(dir, "claude.exe.old.3"))
	no("no digits", filepath.Join(dir, "claude.exe.old.x.1234"))
	no("an empty number", filepath.Join(dir, "claude.exe.old..1234"))
	no("a digit part over 20 digits", filepath.Join(dir, "claude.exe.old.3."+strings.Repeat("1", 21)))
	no("a suffix after the pid", filepath.Join(dir, "claude.exe.old.3.1234.bak"))
	no("a third number", filepath.Join(dir, "claude.exe.old.3.1234.5"))
	no("a prefix on the name", filepath.Join(dir, "xclaude.exe.old.3.1234"))
	no("a leading space", filepath.Join(dir, " claude.exe.old.3.1234"))
	assert.False(t, isSelfUpdatedImage(cli, cli), "the CLI itself is the plain match, not this one")
	assert.False(t, isSelfUpdatedImage(filepath.Join(dir, "claude.exe.old.3.9999"), cli), "a file that does not exist: unreadable is no match")
	assert.False(t, isSelfUpdatedImage(filepath.Join(dir, "claude.exe.old.3.1234"), filepath.Join(dir, "gone.exe")), "an unresolvable CLI is no match")
	assert.False(t, isSelfUpdatedImage("", cli))
	if runtime.GOOS == "windows" {
		assert.False(t, isSelfUpdatedImage(filepath.Join(dir, "claude.exe.old.3.1234:stream"), cli), "an alternate data stream name")
	}
}

func TestASelfUpdatedImageThatIsALinkOrAFolderIsNotTheCLI(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "bin")
	cli := touch(t, filepath.Join(dir, "claude.exe"))
	elsewhere := touch(t, filepath.Join(root, "elsewhere", "claude.exe"))

	// a link in the CLI's folder, with the right name, to a program somewhere else
	link := filepath.Join(dir, "claude.exe.old.3.1234")
	if err := os.Symlink(elsewhere, link); err != nil {
		t.Skipf("cannot create symbolic links here: %v", err)
	}
	assert.False(t, isSelfUpdatedImage(link, cli), "a link: it resolves to another folder")

	// a folder with the right name
	asDir := filepath.Join(dir, "claude.exe.old.4.1234")
	require.NoError(t, os.MkdirAll(asDir, 0o755))
	assert.False(t, isSelfUpdatedImage(asDir, cli), "a directory is not a program image")

	// the image reached through a link to ANOTHER folder: the folders differ after resolving
	viaLink := filepath.Join(root, "viaLink")
	require.NoError(t, os.Symlink(filepath.Join(root, "elsewhere"), viaLink))
	touch(t, filepath.Join(root, "elsewhere", "claude.exe.old.5.1234"))
	assert.False(t, isSelfUpdatedImage(filepath.Join(viaLink, "claude.exe.old.5.1234"), cli), "a link in the image's path to a different folder")

	// the CLI reached through a link to its folder: the same folder after resolving
	linkedDir := filepath.Join(root, "binLink")
	require.NoError(t, os.Symlink(dir, linkedDir))
	real := touch(t, filepath.Join(dir, "claude.exe.old.6.1234"))
	assert.True(t, isSelfUpdatedImage(real, filepath.Join(linkedDir, "claude.exe")), "the CLI given through a link to the same folder")
}

func TestSameImageTakesTheRenamedBinaryOnlyOnWindows(t *testing.T) {
	dir := t.TempDir()
	cli := touch(t, filepath.Join(dir, "claude.exe"))
	renamed := touch(t, filepath.Join(dir, "claude.exe.old.3.1234"))
	assert.True(t, sameImage(cli, cli))
	assert.Equal(t, runtime.GOOS == "windows", sameImage(renamed, cli), "the updater's rename is a Windows case")
	assert.False(t, sameImage(renamed, ""), "no resolved CLI")
	assert.False(t, sameImage("", cli))
	assert.False(t, sameImage(touch(t, filepath.Join(dir, "other.exe")), cli))
}
