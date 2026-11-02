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
// is never refused because an agent works in a folder that contains it. Anywhere else a CLI inside a live agent's working folder is still refused; the temp-folder, data-folder and runnable/owner checks stay.

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

func TestACLIInAProjectOrAnywhereElseIsStillRefusedInAnAgentsFolder(t *testing.T) {
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

	// the git-tree refusal the first version of this change had was dropped (the Orchestrator's decision: it would newly refuse a project's node_modules/.bin, a nix or direnv shell, a CLI built in its own checkout):
	// with no agent working there, a CLI inside a repository is used
	r3 := newNativeRig(t)
	repo := filepath.Join(r3.home, "code", "tools")
	require.NoError(t, os.MkdirAll(filepath.Join(repo, ".git"), 0o755))
	assert.Empty(t, r3.screen(r3.program(filepath.Join(repo, "bin", "agy"), 0o755)), "no git rule: no agent works there")
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

// Security's SHOULDs on #12365: a root that comes from the environment must not be as wide as the home folder (npm's documented "prefix=~" setting), and the folder-chain check is skipped only for the three fixed
// system roots.
func TestAnEnvironmentRootAsWideAsTheHomeFolderIsNotARoot(t *testing.T) {
	for _, env := range []string{"NPM_CONFIG_PREFIX", "PNPM_HOME", "VOLTA_HOME", "BUN_INSTALL", "CARGO_HOME"} {
		t.Run(env, func(t *testing.T) {
			r := newNativeRig(t)
			r.agentIn("aaaaaaaa-0000-4000-8000-000000000021", filepath.Join(r.home, "proj"))
			agy := r.program(filepath.Join(r.home, "proj", "bin", "agy"), 0o755)
			for name, v := range map[string]string{"the home folder": r.home, "a folder above it": filepath.Dir(r.home), "the filesystem root": string(filepath.Separator)} {
				t.Setenv(env, v)
				assert.Contains(t, r.screen(agy), "in an agent's working folder", env+"="+name+" does not make ~/proj/bin a standard root")
			}
		})
	}
}

func TestTheNpmPrefixAddsItsBinAndLibFoldersNotItself(t *testing.T) {
	r := newNativeRig(t)
	r.agentIn("aaaaaaaa-0000-4000-8000-000000000022", r.home)
	prefix := filepath.Join(r.home, "tools", "npm")
	t.Setenv("NPM_CONFIG_PREFIX", prefix)
	assert.Empty(t, r.screen(r.program(filepath.Join(prefix, "bin", "agy"), 0o755)), "<prefix>/bin")
	assert.Empty(t, r.screen(r.program(filepath.Join(prefix, "lib", "node_modules", "pi", "bin", "pi"), 0o755)), "<prefix>/lib")
	assert.Contains(t, r.screen(r.program(filepath.Join(prefix, "other", "agy"), 0o755)), "in an agent's working folder", "what is in the prefix but is not where npm puts programs")
	assert.Contains(t, r.screen(r.program(filepath.Join(prefix, "agy"), 0o755)), "in an agent's working folder", "the prefix folder itself")
}

func TestOnlyTheThreeFixedSystemRootsSkipTheFolderChainCheck(t *testing.T) {
	assert.True(t, systemRoot("/usr/local"))
	assert.True(t, systemRoot("/opt/homebrew"))
	assert.True(t, systemRoot("/home/linuxbrew/.linuxbrew"))
	for _, not := range []string{"/srv/npm", "/usr/local/x", "/opt/homebrew/bin", "/usr", "/opt"} {
		assert.False(t, systemRoot(not), not)
	}
	// an environment root OUTSIDE home gets the chain check: a folder on the way that others can write refuses it
	r := newNativeRig(t)
	outside := t.TempDir() // not under the rig's home
	prefix := filepath.Join(outside, "npm")
	t.Setenv("NPM_CONFIG_PREFIX", prefix)
	r.agentIn("aaaaaaaa-0000-4000-8000-000000000023", outside)
	agy := r.program(filepath.Join(prefix, "bin", "agy"), 0o755)
	require.NoError(t, os.Chmod(prefix, 0o755))
	assert.Empty(t, r.screen(agy), "folders on the way are the user's and not writable by others")
	require.NoError(t, os.Chmod(filepath.Join(prefix, "bin"), 0o775))
	assert.Contains(t, r.screen(agy), "in an agent's working folder", "a group-writable bin folder under an environment root outside home")
}

// QA's SHOULD 1 on #12365: the folder-chain check under home is pinned for BOTH ends. A group-writable ~/.local refuses the typed path (the link in ~/.local/bin) whatever it points at, and a group-writable root that
// only the RESOLVED path is in (here ~/.npm-global) refuses it even though the typed path's own chain is fine.
func TestAGroupWritableRootRefusesTheTypedPathAndTheResolvedPath(t *testing.T) {
	newRig := func(t *testing.T) (r *nativeRig, link, target string) {
		r = newNativeRig(t)
		r.agentIn("aaaaaaaa-0000-4000-8000-000000000024", r.home)
		target = r.program(filepath.Join(r.home, ".npm-global", "lib", "node_modules", "pi", "bin", "pi"), 0o755)
		link = filepath.Join(r.home, ".local", "bin", "pi")
		require.NoError(t, os.MkdirAll(filepath.Dir(link), 0o755))
		require.NoError(t, os.Symlink(target, link))
		return r, link, target
	}
	t.Run("untouched it passes, typed and resolved", func(t *testing.T) {
		r, link, target := newRig(t)
		assert.Empty(t, r.screen(link))
		assert.Empty(t, r.screen(target))
	})
	t.Run("a group-writable ~/.local refuses the typed path", func(t *testing.T) {
		r, link, _ := newRig(t)
		require.NoError(t, os.Chmod(filepath.Join(r.home, ".local"), 0o775))
		assert.Contains(t, r.screen(link), "in an agent's working folder", "the typed link's own chain is not private")
	})
	t.Run("a group-writable ~/.npm-global refuses the resolved path, and so the typed link that leads there", func(t *testing.T) {
		r, link, target := newRig(t)
		require.NoError(t, os.Chmod(filepath.Join(r.home, ".npm-global"), 0o775))
		assert.Contains(t, r.screen(target), "in an agent's working folder", "the resolved path's chain")
		assert.Contains(t, r.screen(link), "in an agent's working folder", "the typed path is in a fine root, but where it resolves is not")
	})
	t.Run("a group-writable folder in the middle of the resolved path", func(t *testing.T) {
		r, link, _ := newRig(t)
		require.NoError(t, os.Chmod(filepath.Join(r.home, ".npm-global", "lib"), 0o775))
		assert.Contains(t, r.screen(link), "in an agent's working folder")
	})
}
