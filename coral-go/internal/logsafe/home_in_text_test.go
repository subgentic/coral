package logsafe

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #10021: an error sentence with a full path in it is stored in a run and read by whoever may see the run: the home folder is written as "~", wherever it is in the text, and only as a whole folder.
func TestHomeInTextWritesTheHomeFolderAsATilde(t *testing.T) {
	homes := []string{"/home/someone"}
	for in, want := range map[string]string{
		"":             "",
		"no path here": "no path here",
		"/home/someone/.local/bin/claude is not installed":             "~/.local/bin/claude is not installed",
		"claude not found at /home/someone/bin/claude (PATH=/usr/bin)": "claude not found at ~/bin/claude (PATH=/usr/bin)",
		"two: /home/someone/a and '/home/someone/b'":                   "two: ~/a and '~/b'",
		"the folder /home/someone":                                     "the folder ~",
		"/home/someoneelse/x is another person's":                      "/home/someoneelse/x is another person's",
		"/srv/home/someone/x":                                          "/srv/home/someone/x",
		"/home/someone" + "-else/x":                                    "/home/someone" + "-else/x", // a dash goes on a name: another folder
	} {
		assert.Equal(t, want, homeInText(in, homes), in)
	}
	assert.Equal(t, "/x", homeInText("/x", []string{"", "/"}), "an empty or root home is not a folder to hide")
	assert.Equal(t, "~/x ~/y", homeInText("/home/ann/x /srv/bob/y", []string{"/home/ann", "/srv/bob/"}), "each home, and a home written with a trailing slash")
}

func TestHomeInTextUsesTheEnvironmentsHome(t *testing.T) {
	t.Setenv("HOME", "/home/runner")
	t.Setenv("USERPROFILE", "")
	assert.Equal(t, "~/.local/bin/agy is not installed", HomeInText("/home/runner/.local/bin/agy is not installed"))
}
