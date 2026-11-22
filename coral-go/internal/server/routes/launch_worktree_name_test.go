package routes

import (
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20618 (QA's SHOULDs on #20614): the one join of a worktree's name to <repo>-worktrees is checked on its own.
func TestUnderDefaultWorktreeDirTakesOnePlainNameOnly(t *testing.T) {
	root := filepath.Join(t.TempDir(), "repo")
	def := defaultWorktreeDir(root)
	for _, bad := range []string{"", ".", "..", "a/b", `a\b`, "../x", ".hidden", "-lead", "a b", strings.Repeat("a", 65)} {
		assert.Equal(t, "", underDefaultWorktreeDir(root, bad), "%q is not one plain folder name", bad)
		assert.Equal(t, "", worktreePathFor(root, bad, ""), "a refused name has no folder (%q)", bad)
	}
	for _, good := range []string{"fix-login", "a", "v1.2_x", strings.Repeat("a", 64), "_lead"} {
		assert.Equal(t, filepath.Join(def, good), underDefaultWorktreeDir(root, good), good)
	}
	assert.Equal(t, filepath.Clean("/elsewhere/mine"), worktreePathFor(root, "..", "/elsewhere/mine"), "a folder the person typed is used as typed, cleaned")
}

func TestLaunchCheckLeavesOutTheTrustLineWhenTheNameIsRefused(t *testing.T) {
	srv, _ := launchWhereServer(t)
	repo, _ := repoOn(t, "trunk", true)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	ask := func(name string) map[string]any {
		return launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "type": {"claude"}, "new_worktree": {name}})
	}
	bad := ask("a b")
	require.NotNil(t, checkOf(bad, "worktree_free"))
	assert.Equal(t, false, checkOf(bad, "worktree_free")["ok"])
	assert.Nil(t, checkOf(bad, "trusted"), "no folder, so no 'Claude will ask about this folder' line beside the refusal")
	assert.NotNil(t, checkOf(ask("fix-login"), "trusted"), "a good name still gets its trust line")
}
