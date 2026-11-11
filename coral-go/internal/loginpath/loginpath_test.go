package loginpath

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseTakesThePathBetweenTheMarksWhateverTheProfilePrinted(t *testing.T) {
	out := "Last login: Mon\nwelcome to zsh\n" + beginMark + "/opt/homebrew/bin:/usr/bin" + endMark + "\nbye\n"
	assert.Equal(t, "/opt/homebrew/bin:/usr/bin", parse(out))
	assert.Equal(t, "", parse("no marks here"))
	assert.Equal(t, "", parse(beginMark+"/usr/bin without an end"))
	assert.Equal(t, "/b", parse(beginMark+"/a"+endMark+beginMark+"/b"+endMark), "the last answer is the shell's own: an earlier one was a profile's echo")
}

func TestMergeAppendsTheMissingFoldersAndNeverReorders(t *testing.T) {
	got, added := Merge("/usr/bin:/bin:/usr/sbin:/sbin", "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/Users/me/.nvm/v20/bin", ":")
	assert.Equal(t, "/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin:/opt/homebrew/bin:/Users/me/.nvm/v20/bin", got, "what the process had stays first and in its order")
	assert.Equal(t, 3, added)
}

func TestMergeTakesOnlyFolderNamesFromWhatAShellPrinted(t *testing.T) {
	got, added := Merge("/usr/bin", "relative/dir::/ok/dir:/bad\ndir:/tab\tdir:/ok/dir:$(rm -rf):/x", ":")
	assert.Equal(t, "/usr/bin:/ok/dir:/x", got, "a relative entry, an empty one, a control character and a repeat are left out")
	assert.Equal(t, 2, added)
	got, added = Merge("/usr/bin", "/usr/bin", ":")
	assert.Equal(t, "/usr/bin", got)
	assert.Zero(t, added)
}
