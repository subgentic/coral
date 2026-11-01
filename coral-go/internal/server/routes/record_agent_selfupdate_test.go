package routes

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Claude Code renames its running binary to <name>.old.<n>.<pid> when it updates itself: the bulk record still takes that process as the resolved CLI, in the CLI's own folder only.
func TestASelfUpdatedImageIsTheCLIInItsOwnFolderOnly(t *testing.T) {
	dir := filepath.Join(`C:\`, "Users", "me", ".local", "bin")
	cli := filepath.Join(dir, "claude.exe")
	for name, c := range map[string]struct {
		image string
		want  bool
	}{
		"the renamed running binary":      {filepath.Join(dir, "claude.exe.old.3.1234"), true},
		"upper case":                      {filepath.Join(dir, "CLAUDE.EXE.OLD.12.99"), true},
		"another folder":                  {filepath.Join(`C:\`, "Users", "other", "claude.exe.old.3.1234"), false},
		"a sub folder":                    {filepath.Join(dir, "x", "claude.exe.old.3.1234"), false},
		"another program":                 {filepath.Join(dir, "evil.exe.old.3.1234"), false},
		"no pid":                          {filepath.Join(dir, "claude.exe.old.3"), false},
		"a non-number":                    {filepath.Join(dir, "claude.exe.old.x.1234"), false},
		"an empty number":                 {filepath.Join(dir, "claude.exe.old..1234"), false},
		"a suffix after the pid":          {filepath.Join(dir, "claude.exe.old.3.1234.bak"), false},
		"a three part tail":               {filepath.Join(dir, "claude.exe.old.3.1234.5"), false},
		"a prefix on the name":            {filepath.Join(dir, "xclaude.exe.old.3.1234"), false},
		"the CLI itself is not this case": {cli, false},
	} {
		assert.Equal(t, c.want, isSelfUpdatedImage(c.image, cli), name)
	}
}

func TestSameImageOnlyAcceptsTheRenamedBinaryOnWindows(t *testing.T) {
	dir := t.TempDir()
	cli := filepath.Join(dir, "claude.exe")
	assert.False(t, sameImage(filepath.Join(dir, "claude.exe.old.3.1234"), ""), "no resolved CLI")
	assert.False(t, sameImage("", cli))
	assert.False(t, sameImage(filepath.Join(dir, "other.exe"), cli))
}
