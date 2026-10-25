//go:build !windows

package agentmemory

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/transcriptlink"
)

// Tests that need a named pipe or a file name Windows refuses: not built on Windows (syscall.Mkfifo does not exist there).

func TestAPipeIsNotRegularAndReadingItDoesNotHang(t *testing.T) {
	r := newRig(t)
	require.NoError(t, syscall.Mkfifo(filepath.Join(r.proj, "CLAUDE.md"), 0o644))
	files := Discover("claude", r.proj, r.repo, r.home)
	require.Len(t, files, 1)
	assert.Equal(t, ProblemNotRegular, files[0].Problem)
	_, err := files[0].Read()
	assert.Error(t, err)
}

// a link to a pipe is not followed, and reading it does not hang
func TestALinkToAPipeIsNotFollowed(t *testing.T) {
	r := newRig(t)
	require.NoError(t, syscall.Mkfifo(filepath.Join(r.proj, "CLAUDE.md"), 0o644))
	require.NoError(t, os.Symlink("CLAUDE.md", filepath.Join(r.proj, "AGENTS.md")))
	fs := Discover("codex", r.proj, r.repo, r.home)
	require.Len(t, fs, 1)
	assert.Equal(t, ProblemLink, fs[0].Problem)
	_, err := fs[0].Read()
	assert.Error(t, err)
}

// safefs.CheckName keeps an odd name out of the memory list (a name with a control character).
func TestAMemoryFileWithAnOddNameIsNotListed(t *testing.T) {
	r := newRig(t)
	mem := filepath.Join(r.home, ".claude", "projects", transcriptlink.ClaudeProjectDirName(r.proj), "memory")
	write(t, filepath.Join(mem, "good.md"), "ok")
	write(t, filepath.Join(mem, "bad\nname.md"), "newline in the name")
	write(t, filepath.Join(mem, "bad\x01.md"), "control character")
	var got []string
	for _, f := range Discover("claude", r.proj, r.repo, r.home) {
		got = append(got, f.Name)
	}
	assert.Equal(t, []string{"good.md"}, got)
}
