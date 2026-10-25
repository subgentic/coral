package agentmemory

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/transcriptlink"
)

func write(t *testing.T, path, text string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(text), 0o644))
}

// rig: a home folder and a repository below it, a project folder in the repository, and a folder above the repository with a file that must never be listed.
type rig struct{ home, above, repo, proj string }

func newRig(t *testing.T) rig {
	t.Helper()
	base, err := safefs.Resolve(t.TempDir())
	require.NoError(t, err)
	r := rig{home: filepath.Join(base, "home")}
	r.above = filepath.Join(r.home, "work")
	r.repo = filepath.Join(r.above, "repo")
	r.proj = filepath.Join(r.repo, "pkg", "app")
	require.NoError(t, os.MkdirAll(r.proj, 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(r.repo, ".git"), 0o755))
	return r
}

// w is the Where of a folder under the rig's home, as the list writes it.
func (r rig) w(dir string) string {
	rel, _ := filepath.Rel(r.home, dir)
	return filepath.Join("~", rel)
}

func names(fs []File) (out []string) {
	for _, f := range fs {
		out = append(out, f.Level+"/"+f.Kind+"/"+f.Where+"/"+f.Name)
	}
	return
}

func TestClaudeFilesAreTheProjectsParentsUpToTheGitRootTheUsersAndTheMemoryNearestFirst(t *testing.T) {
	r := newRig(t)
	write(t, filepath.Join(r.proj, "CLAUDE.md"), "project")
	write(t, filepath.Join(r.repo, "pkg", "CLAUDE.md"), "parent")
	write(t, filepath.Join(r.repo, "CLAUDE.md"), "root")
	write(t, filepath.Join(r.above, "CLAUDE.md"), "above the repository: never listed")
	write(t, filepath.Join(r.home, "CLAUDE.md"), "the home folder's own: the user level is ~/.claude")
	write(t, filepath.Join(r.proj, "AGENTS.md"), "another CLI's")
	write(t, filepath.Join(r.home, ".claude", "CLAUDE.md"), "user")
	mem := filepath.Join(r.home, ".claude", "projects", transcriptlink.ClaudeProjectDirName(r.proj), "memory")
	write(t, filepath.Join(mem, "zeta.md"), "z")
	write(t, filepath.Join(mem, "MEMORY.md"), "index")
	write(t, filepath.Join(mem, "alpha.md"), "a")
	write(t, filepath.Join(mem, "notes.txt"), "not markdown")

	got := names(Discover("claude", r.proj, r.repo, r.home))
	assert.Equal(t, []string{
		"project/instructions/" + r.w(r.proj) + "/CLAUDE.md",
		"parent/instructions/" + r.w(filepath.Join(r.repo, "pkg")) + "/CLAUDE.md",
		"parent/instructions/" + r.w(r.repo) + "/CLAUDE.md",
		"user/instructions/~/.claude/CLAUDE.md",
		"project/memory/" + filepath.Join("~", ".claude", "projects", transcriptlink.ClaudeProjectDirName(r.proj), "memory") + "/MEMORY.md",
		"project/memory/" + filepath.Join("~", ".claude", "projects", transcriptlink.ClaudeProjectDirName(r.proj), "memory") + "/alpha.md",
		"project/memory/" + filepath.Join("~", ".claude", "projects", transcriptlink.ClaudeProjectDirName(r.proj), "memory") + "/zeta.md",
	}, got)
}

func TestACodexAgentSeesItsOwnNamesNotClaudes(t *testing.T) {
	r := newRig(t)
	write(t, filepath.Join(r.proj, "CLAUDE.md"), "claude's")
	write(t, filepath.Join(r.proj, "AGENTS.md"), "codex's")
	write(t, filepath.Join(r.home, ".codex", "AGENTS.md"), "user")
	write(t, filepath.Join(r.home, ".claude", "CLAUDE.md"), "claude's user file")
	assert.Equal(t, []string{"project/instructions/" + r.w(r.proj) + "/AGENTS.md", "user/instructions/~/.codex/AGENTS.md"}, names(Discover("codex", r.proj, r.repo, r.home)))
	assert.Equal(t, []string{"project/instructions/" + r.w(r.proj) + "/AGENTS.md", "project/instructions/" + r.w(r.proj) + "/CLAUDE.md"}, names(Discover("pi", r.proj, r.repo, r.home)), "Pi reads both")
}

func TestWithNoGitRootOnlyTheWorkingFolderIsLookedAt(t *testing.T) {
	r := newRig(t)
	write(t, filepath.Join(r.proj, "CLAUDE.md"), "project")
	write(t, filepath.Join(r.above, "CLAUDE.md"), "a parent, but there is no repository to bound the walk")
	assert.Equal(t, []string{"project/instructions/" + r.w(r.proj) + "/CLAUDE.md"}, names(Discover("claude", r.proj, "", r.home)))
	assert.Empty(t, Discover("claude", "", "", ""))
	assert.Empty(t, Discover("claude", filepath.Join(r.home, "gone"), "", r.home))
}

func TestAWorkingFolderOutsideItsGitRootDoesNotWalkUp(t *testing.T) {
	r := newRig(t)
	other := filepath.Join(filepath.Dir(r.home), "elsewhere")
	require.NoError(t, os.MkdirAll(other, 0o755))
	write(t, filepath.Join(other, "CLAUDE.md"), "here")
	write(t, filepath.Join(filepath.Dir(other), "CLAUDE.md"), "its parent")
	assert.Equal(t, []string{"project/instructions/" + other + "/CLAUDE.md"}, names(Discover("claude", other, r.repo, r.home)), "a git root that does not contain the folder bounds nothing")
}

func TestALinkIsListedAsALinkAndNeverRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	r := newRig(t)
	secret := filepath.Join(r.home, ".ssh", "id_secret")
	write(t, secret, "PRIVATE KEY MATERIAL")
	require.NoError(t, os.Symlink(secret, filepath.Join(r.proj, "CLAUDE.md")))
	require.NoError(t, os.Symlink("CLAUDE.md", filepath.Join(r.proj, "CLAUDE.local.md"))) // a link inside the folder is a link too
	files := Discover("claude", r.proj, r.repo, r.home)
	require.Len(t, files, 2)
	for _, f := range files {
		assert.Equal(t, ProblemLink, f.Problem, f.Name)
		c, err := f.Read()
		assert.Error(t, err, "%s: not followed", f.Name)
		assert.NotContains(t, c.Text, "PRIVATE")
	}
}

func TestAMemoryFolderThatLeadsOutOfHomeIsNotRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	r := newRig(t)
	outside, err := safefs.Resolve(t.TempDir())
	require.NoError(t, err)
	write(t, filepath.Join(outside, "stolen.md"), "outside home")
	mem := filepath.Join(r.home, ".claude", "projects", transcriptlink.ClaudeProjectDirName(r.proj), "memory")
	require.NoError(t, os.MkdirAll(filepath.Dir(mem), 0o755))
	require.NoError(t, os.Symlink(outside, mem))
	assert.Empty(t, Discover("claude", r.proj, r.repo, r.home))
}

func TestReadGivesTextCutsALargeFileOnACharacterAndCallsBinaryBinary(t *testing.T) {
	r := newRig(t)
	one := func(text string) File {
		t.Helper()
		write(t, filepath.Join(r.proj, "CLAUDE.md"), text)
		files := Discover("claude", r.proj, r.repo, "")
		require.Len(t, files, 1)
		return files[0]
	}
	c, err := one("# Rules\nbe kind\n").Read()
	require.NoError(t, err)
	assert.Equal(t, Content{Text: "# Rules\nbe kind\n", Size: 16}, c)

	big := strings.Repeat("é", MaxRead) // two bytes a character: the cut falls inside one when MaxRead is odd
	c, err = one("x" + big).Read()
	require.NoError(t, err)
	assert.True(t, c.Truncated)
	assert.LessOrEqual(t, len(c.Text), MaxRead)
	assert.Equal(t, int64(1+2*MaxRead), c.Size)
	assert.True(t, strings.HasPrefix(c.Text, "xé"))

	c, err = one("a\x00b").Read()
	require.NoError(t, err)
	assert.True(t, c.Binary)
	assert.Empty(t, c.Text)
	c, err = one("\xff\xfe not utf-8").Read()
	require.NoError(t, err)
	assert.True(t, c.Binary)

	f := one("here")
	require.NoError(t, os.Remove(filepath.Join(r.proj, "CLAUDE.md")))
	_, err = f.Read()
	assert.ErrorIs(t, err, ErrGone)
}

// #7454 (the Orchestrator's decision): a link is followed only when its target is a regular file inside the SAME folder (AGENTS.md pointing at CLAUDE.md); it is then shown with that file's text and says what
// it links to. A link that leaves the folder, a dangling one, one to a folder and one to a pipe stay listed with their problem and are never read.
func TestALinkIsFollowedOnlyToAFileInTheSameFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	r := newRig(t)
	outside := filepath.Join(r.home, ".ssh", "id_secret")
	write(t, outside, "PRIVATE KEY MATERIAL")
	write(t, filepath.Join(r.proj, "CLAUDE.md"), "the real instructions")
	write(t, filepath.Join(r.proj, "docs", "rules.md"), "rules in a subfolder")
	write(t, filepath.Join(r.proj, ".env"), "API_KEY=SECRET")
	write(t, filepath.Join(r.proj, ".git", "config"), "[remote] url = https://user:SECRET@example.invalid/x.git")
	write(t, filepath.Join(r.proj, ".hidden", "CLAUDE.md"), "SECRET")
	write(t, filepath.Join(r.proj, "notes.txt"), "SECRET")
	require.NoError(t, os.Symlink("CLAUDE.md", filepath.Join(r.proj, "AGENTS.md")))
	got := func(agent string) []File { return Discover(agent, r.proj, r.repo, r.home) }

	// Codex lists AGENTS.md, which is a link to CLAUDE.md in the same folder: followed, said, and read as that file.
	fs := got("codex")
	require.Len(t, fs, 1)
	assert.Equal(t, "AGENTS.md", fs[0].Name)
	assert.Equal(t, "CLAUDE.md", fs[0].LinkTo)
	assert.Empty(t, fs[0].Problem)
	assert.EqualValues(t, len("the real instructions"), fs[0].Size)
	c, err := fs[0].Read()
	require.NoError(t, err)
	assert.Equal(t, "the real instructions", c.Text)

	// a link into a subfolder is followed only to an instruction file there (not docs/rules.md)
	write(t, filepath.Join(r.proj, "sub", "CLAUDE.md"), "an instruction file in a subfolder")
	require.NoError(t, os.Remove(filepath.Join(r.proj, "AGENTS.md")))
	require.NoError(t, os.Symlink(filepath.Join("sub", "CLAUDE.md"), filepath.Join(r.proj, "AGENTS.md")))
	fs = got("codex")
	require.Len(t, fs, 1)
	assert.Equal(t, "sub/CLAUDE.md", fs[0].LinkTo)
	c, err = fs[0].Read()
	require.NoError(t, err)
	assert.Equal(t, "an instruction file in a subfolder", c.Text)

	for name, target := range map[string]string{
		"out of the folder":                       outside,
		"a relative way out":                      filepath.Join("..", "..", "..", "..", ".ssh", "id_secret"),
		"a folder":                                "docs",
		"nothing there (dangling)":                "gone.md",
		"a file that is not an instruction file":  filepath.Join("docs", "rules.md"),
		"a secret file in the folder":             ".env",
		"a file in a dot-folder":                  filepath.Join(".git", "config"),
		"an instruction name inside a dot-folder": filepath.Join(".hidden", "CLAUDE.md"),
		"a plain file with another name":          "notes.txt",
	} {
		require.NoError(t, os.Remove(filepath.Join(r.proj, "AGENTS.md")))
		require.NoError(t, os.Symlink(target, filepath.Join(r.proj, "AGENTS.md")))
		fs = got("codex")
		require.Len(t, fs, 1, name)
		assert.Equal(t, ProblemLink, fs[0].Problem, name)
		assert.Empty(t, fs[0].LinkTo, name)
		c, err = fs[0].Read()
		assert.Error(t, err, name)
		assert.NotContains(t, c.Text, "PRIVATE", name)
		assert.NotContains(t, c.Text, "SECRET", name)
	}

	// a link to a link that ends outside the folder is not followed either
	require.NoError(t, os.Remove(filepath.Join(r.proj, "AGENTS.md")))
	require.NoError(t, os.Symlink(outside, filepath.Join(r.proj, "hop.md")))
	require.NoError(t, os.Symlink("hop.md", filepath.Join(r.proj, "AGENTS.md")))
	fs = got("codex")
	require.Len(t, fs, 1)
	assert.Equal(t, ProblemLink, fs[0].Problem, "the first hop is inside, the last leaves")
}
