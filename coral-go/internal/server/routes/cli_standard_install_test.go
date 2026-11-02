//go:build !windows

package routes

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12365 (the Operator: "we shouldn't prevent ~/.local from being referenced; it's too confusing", with Security's answer on #353): a CLI in a standard install root, judged on both the typed and the resolved path,
// is never refused because an agent works in a folder that contains it. Anywhere else a CLI inside a live agent's working folder or a git working tree is still refused; the temp-folder, data-folder and
// runnable/owner checks stay.

func (r *nativeRig) program(p string, mode os.FileMode) string {
	r.t.Helper()
	require.NoError(r.t, os.MkdirAll(filepath.Dir(p), 0o755))
	require.NoError(r.t, os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), mode))
	require.NoError(r.t, os.Chmod(p, mode))
	return p
}

func TestACLIInAStandardInstallFolderIsNotRefusedBecauseAnAgentWorksInTheHomeFolder(t *testing.T) {
	r := newNativeRig(t)
	r.agentIn("aaaaaaaa-0000-4000-8000-000000000011", r.home)
	for name, p := range map[string]string{
		"~/.local/bin, a plain program (agy)": r.program(filepath.Join(r.home, ".local", "bin", "agy"), 0o755),
		"~/bin":                               r.program(filepath.Join(r.home, "bin", "pi"), 0o755),
		"~/.cargo/bin":                        r.program(filepath.Join(r.home, ".cargo", "bin", "agy"), 0o755),
		"the npm global folder":               r.program(filepath.Join(r.home, ".npm-global", "bin", "pi"), 0o755),
		"a Volta shim folder":                 r.program(filepath.Join(r.home, ".volta", "bin", "pi"), 0o755),
	} {
		assert.Empty(t, r.screen(p), name)
		assert.Empty(t, untrustedLocationOf(t.Context(), r.h.cfg, r.h.ss, p), name)
	}
	// pi in ~/.local/bin is a link into a global npm tree under home: the typed path and where it resolves are both in standard roots
	target := r.program(filepath.Join(r.home, ".npm-global", "lib", "node_modules", "pi", "bin", "pi"), 0o755)
	link := filepath.Join(r.home, ".local", "bin", "pi")
	require.NoError(t, os.Symlink(target, link))
	assert.Empty(t, r.screen(link), "the typed link")
	assert.Empty(t, r.screen(target), "what it resolves to")
	// the pnpm home and the npm prefix the environment names count too
	pnpm := filepath.Join(r.home, "somewhere", "pnpm")
	t.Setenv("PNPM_HOME", pnpm)
	assert.Empty(t, r.screen(r.program(filepath.Join(pnpm, "agy"), 0o755)), "PNPM_HOME")
	prefix := filepath.Join(r.home, "elsewhere", "npm")
	t.Setenv("NPM_CONFIG_PREFIX", prefix)
	assert.Empty(t, r.screen(r.program(filepath.Join(prefix, "bin", "agy"), 0o755)), "the npm global prefix")
}

func TestACLIInAProjectOrAnywhereElseIsStillRefusedInAnAgentsFolderAndInAGitTree(t *testing.T) {
	r := newNativeRig(t)
	proj := filepath.Join(r.home, "proj")
	agy := r.program(filepath.Join(proj, "bin", "agy"), 0o755)
	r.agentIn("aaaaaaaa-0000-4000-8000-000000000012", proj)
	assert.Contains(t, r.screen(agy), "in an agent's working folder", "an agent in ~/proj with ~/proj/bin/agy")

	// an agent in ~ covers a project under it too
	r2 := newNativeRig(t)
	r2.agentIn("aaaaaaaa-0000-4000-8000-000000000013", r2.home)
	assert.Contains(t, r2.screen(r2.program(filepath.Join(r2.home, "proj", "bin", "agy"), 0o755)), "in an agent's working folder")
	assert.Contains(t, r2.screen(r2.program(filepath.Join(r2.home, "Downloads", "agy"), 0o755)), "in an agent's working folder")
	// a CLI that only looks like a standard root: a lookalike name under home is not one
	assert.Contains(t, r2.screen(r2.program(filepath.Join(r2.home, ".localx", "bin", "agy"), 0o755)), "in an agent's working folder", ".localx is not .local")
	assert.Contains(t, r2.screen(r2.program(filepath.Join(r2.home, "bins", "agy"), 0o755)), "in an agent's working folder", "bins is not bin")

	// no agent works there, but the CLI is inside a git working tree: refused
	r3 := newNativeRig(t)
	repo := filepath.Join(r3.home, "code", "tools")
	require.NoError(t, os.MkdirAll(filepath.Join(repo, ".git"), 0o755))
	inRepo := r3.program(filepath.Join(repo, "bin", "agy"), 0o755)
	assert.Contains(t, r3.screen(inRepo), "git working tree")
	// a worktree's .git is a file
	wt := filepath.Join(r3.home, "code", "wt")
	require.NoError(t, os.MkdirAll(wt, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: /x\n"), 0o644))
	assert.Contains(t, r3.screen(r3.program(filepath.Join(wt, "agy"), 0o755)), "git working tree")
	// the same program with no .git above it and no agent: fine (a tool folder that is not a repo)
	assert.Empty(t, r3.screen(r3.program(filepath.Join(r3.home, "tools", "agy"), 0o755)))
	// the home folder being a git tree itself (a dotfiles repo) does not make everything under it one
	require.NoError(t, os.MkdirAll(filepath.Join(r3.home, ".git"), 0o755))
	assert.Empty(t, r3.screen(r3.program(filepath.Join(r3.home, "tools2", "agy"), 0o755)), "home's own .git is not a project")
	assert.Empty(t, r3.screen(r3.program(filepath.Join(r3.home, ".local", "bin", "agy"), 0o755)), "and ~/.local/bin is a standard root first")
}

func TestAStandardRootsFileStillHasToBeTheUsersAndNotWritableByOthers(t *testing.T) {
	r := newNativeRig(t)
	r.agentIn("aaaaaaaa-0000-4000-8000-000000000014", r.home)
	loose := r.program(filepath.Join(r.home, ".local", "bin", "agy"), 0o777) // others can write it: a planted-file risk the working-folder rule still covers
	assert.Contains(t, r.screen(loose), "in an agent's working folder")
	grp := r.program(filepath.Join(r.home, ".local", "bin", "pi"), 0o775)
	assert.Contains(t, r.screen(grp), "in an agent's working folder")
	// a link from a standard root to a place outside every root is refused: the resolved path is judged too
	outside := r.program(filepath.Join(r.home, "Downloads", "evil"), 0o755)
	link := filepath.Join(r.home, ".local", "bin", "evillink")
	require.NoError(t, os.Symlink(outside, link))
	assert.Contains(t, r.screen(link), "in an agent's working folder")
	// a link that stays inside the roots to a folder not a regular file is refused (not a program)
	dirTarget := filepath.Join(r.home, ".local", "share", "adir")
	require.NoError(t, os.MkdirAll(dirTarget, 0o755))
	dirLink := filepath.Join(r.home, ".local", "bin", "dirlink")
	require.NoError(t, os.Symlink(dirTarget, dirLink))
	assert.Contains(t, r.screen(dirLink), "in an agent's working folder")
}

func TestAnAgentWorkingInsideAStandardInstallFolderDoesNotRefuseItsCLIsEither(t *testing.T) {
	for name, dir := range map[string]func(r *nativeRig) string{
		"~/.local":     func(r *nativeRig) string { return filepath.Join(r.home, ".local") },
		"~/.local/bin": func(r *nativeRig) string { return filepath.Join(r.home, ".local", "bin") },
	} {
		t.Run(name, func(t *testing.T) {
			r := newNativeRig(t)
			agy := r.program(filepath.Join(r.home, ".local", "bin", "agy"), 0o755)
			r.agentIn("aaaaaaaa-0000-4000-8000-000000000015", dir(r))
			assert.Empty(t, r.screen(agy), "agents can be started in those folders after the CLI is chosen: the rule adds nothing there")
			assert.Empty(t, r.screen(r.link))
		})
	}
}
