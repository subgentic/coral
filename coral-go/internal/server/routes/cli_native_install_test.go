//go:build !windows

package routes

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
)

// #11454 (Security's ruling): an agent whose working folder is the home folder covers everything under it, which refused the native installer's claude (~/.local/bin/claude, a link into
// ~/.local/share/claude/versions/<v>) on a Mac with two agents working in ~. Only that fixed place is exempt, under conditions; every other path under home stays refused.

type nativeRig struct {
	t       *testing.T
	home    string
	h       *SessionsHandler
	ss      *store.SessionStore
	version string // the real target
	link    string // ~/.local/bin/claude
}

func newNativeRig(t *testing.T) *nativeRig {
	t.Helper()
	_, h, _, ss := setupSessionsTestServer(t)
	// The fake home is in the package's own folder, not in the system temp folder: a CLI there is refused as a temporary one before any screen (agent.InTempFolder), which is not what these tests are about.
	here, err := filepath.Abs(".")
	require.NoError(t, err)
	home, err := os.MkdirTemp(here, "nativehome-")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) }) // this folder only, by its exact name
	t.Setenv("HOME", home)
	prev := cliTempDirs
	cliTempDirs = func() []string { return nil } // the test's folders are in a temp folder; the screens below are for the working folder alone
	t.Cleanup(func() { cliTempDirs = prev })
	r := &nativeRig{t: t, home: home, h: h, ss: ss}
	versions := filepath.Join(home, ".local", "share", "claude", "versions")
	require.NoError(t, os.MkdirAll(versions, 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755))
	r.version = filepath.Join(versions, "2.1.316")
	require.NoError(t, os.WriteFile(r.version, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	r.link = filepath.Join(home, ".local", "bin", "claude")
	require.NoError(t, os.Symlink(r.version, r.link))
	return r
}

func (r *nativeRig) agentIn(sid, dir string) {
	r.t.Helper()
	require.NoError(r.t, r.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "Dev", WorkingDir: dir}))
}

func (r *nativeRig) screen(p string) string { return r.h.commonPlaceScreen(context.Background())(p) }

func TestTheNativeInstallersClaudeIsNotRefusedBecauseAnAgentWorksInTheHomeFolder(t *testing.T) {
	r := newNativeRig(t)
	r.agentIn("aaaaaaaa-0000-4000-8000-000000000001", r.home)
	assert.Empty(t, r.screen(r.link), "the typed path")
	assert.Empty(t, r.screen(r.version), "what it resolves to")
	// the Settings check looks at both
	assert.Empty(t, untrustedLocationOf(context.Background(), r.h.cfg, r.h.ss, r.link))

	// end to end through the launch lookup, with a PATH that does not hold it: the link is the answer, never the version file, so the updater's new target is followed at the next launch
	t.Setenv("PATH", t.TempDir())
	got, err := agent.LaunchCLIScreened(nil, "claude", r.screen)
	require.NoError(t, err)
	assert.Equal(t, r.link, got, "the link, not the version it points at")
	next := filepath.Join(filepath.Dir(r.version), "2.1.317")
	require.NoError(t, os.WriteFile(next, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, os.Remove(r.link))
	require.NoError(t, os.Symlink(next, r.link))
	got, err = agent.LaunchCLIScreened(nil, "claude", r.screen)
	require.NoError(t, err)
	assert.Equal(t, r.link, got, "the same path after the updater moved the link")
}

func TestEverythingElseUnderTheHomeFolderIsStillRefusedWhileAnAgentWorksThere(t *testing.T) {
	r := newNativeRig(t)
	r.agentIn("aaaaaaaa-0000-4000-8000-000000000002", r.home)
	mk := func(p string) string {
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755))
		return p
	}
	for name, p := range map[string]string{
		"a download":                    mk(filepath.Join(r.home, "Downloads", "claude")),
		"a project's bin":               mk(filepath.Join(r.home, "proj", "bin", "claude")),
		"another CLI planted in .local": mk(filepath.Join(r.home, ".local", "bin", "codex")),
		"a file in .local/bin that is not a link into versions": mk(filepath.Join(r.home, ".local", "bin", "claude2")),
		"a nvm install": mk(filepath.Join(r.home, ".nvm", "versions", "node", "v20", "bin", "claude")),
	} {
		assert.Contains(t, r.screen(p), "in an agent's working folder", name)
	}
	// a link in the right place to somewhere else is refused
	elsewhere := mk(filepath.Join(r.home, "Downloads", "evil"))
	other := filepath.Join(r.home, ".local", "bin", "gemini")
	require.NoError(t, os.Symlink(elsewhere, other))
	assert.Contains(t, r.screen(other), "in an agent's working folder", "a link into the versions folder is the only link")
	require.NoError(t, os.Remove(r.link))
	require.NoError(t, os.Symlink(elsewhere, r.link))
	assert.Contains(t, r.screen(r.link), "in an agent's working folder", "~/.local/bin/claude pointing outside the versions folder")
	// a link inside the versions folder to somewhere else is not the installer's file either
	inner := filepath.Join(filepath.Dir(r.version), "9.9.9")
	require.NoError(t, os.Symlink(elsewhere, inner))
	assert.Contains(t, r.screen(inner), "in an agent's working folder", "a link inside versions/ that leaves it")
}

func TestAnAgentWorkingInsideTheInstallFoldersStillRefusesThem(t *testing.T) {
	for name, dir := range map[string]func(r *nativeRig) string{
		"~/.local":                func(r *nativeRig) string { return filepath.Join(r.home, ".local") },
		"~/.local/bin":            func(r *nativeRig) string { return filepath.Join(r.home, ".local", "bin") },
		"inside the share folder": func(r *nativeRig) string { return filepath.Dir(r.version) },
		"~/.local/share/claude":   func(r *nativeRig) string { return filepath.Join(r.home, ".local", "share", "claude") },
	} {
		t.Run(name, func(t *testing.T) {
			r := newNativeRig(t)
			r.agentIn("aaaaaaaa-0000-4000-8000-000000000003", dir(r))
			assert.Contains(t, r.screen(r.link), "in an agent's working folder", "the exemption is for the home folder case only")
			if name != "~/.local/bin" { // the typed link is the one in ~/.local/bin; its target is under the share folder, which that agent does not work in
				assert.Contains(t, r.screen(r.version), "in an agent's working folder")
			}
		})
	}
}

func TestTheNativeInstallersFilesMustBeTheUsersAndNotWritableByOthers(t *testing.T) {
	for name, tamper := range map[string]func(r *nativeRig){
		"a group-writable target":         func(r *nativeRig) { require.NoError(t, os.Chmod(r.version, 0o775)) },
		"a world-writable target":         func(r *nativeRig) { require.NoError(t, os.Chmod(r.version, 0o757)) },
		"a group-writable bin folder":     func(r *nativeRig) { require.NoError(t, os.Chmod(filepath.Dir(r.link), 0o775)) },
		"a world-writable versions dir":   func(r *nativeRig) { require.NoError(t, os.Chmod(filepath.Dir(r.version), 0o777)) },
		"a group-writable ~/.local":       func(r *nativeRig) { require.NoError(t, os.Chmod(filepath.Join(r.home, ".local"), 0o775)) },
		"a group-writable ~/.local/share": func(r *nativeRig) { require.NoError(t, os.Chmod(filepath.Join(r.home, ".local", "share"), 0o775)) },
		"a world-writable share/<cli> folder": func(r *nativeRig) {
			require.NoError(t, os.Chmod(filepath.Join(r.home, ".local", "share", "claude"), 0o777))
		},
		"a target that is a folder": func(r *nativeRig) {
			require.NoError(t, os.Remove(r.version))
			require.NoError(t, os.Mkdir(r.version, 0o755))
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := newNativeRig(t)
			r.agentIn("aaaaaaaa-0000-4000-8000-000000000004", r.home)
			require.Empty(t, r.screen(r.link), "untouched, it passes")
			tamper(r)
			assert.NotEmpty(t, r.screen(r.link), name)
		})
	}
}

func TestTheDataFolderAndTheTempFolderAreStillRefusedAndTheRefusalNamesTheAgent(t *testing.T) {
	r := newNativeRig(t)
	dn := "Dev team lead"
	require.NoError(t, r.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "aaaaaaaa-0000-4000-8000-000000000005", AgentType: "claude", AgentName: "claude-x", DisplayName: &dn, WorkingDir: r.home}))
	// the data folder, under home
	data := filepath.Join(r.home, ".coral")
	require.NoError(t, os.MkdirAll(data, 0o755))
	r.h.cfg.UseCoralDir(data)
	cli := filepath.Join(data, "hooks", "claude")
	require.NoError(t, os.MkdirAll(filepath.Dir(cli), 0o755))
	require.NoError(t, os.WriteFile(cli, []byte("#!/bin/sh\n"), 0o755))
	assert.Equal(t, "in Coral's data folder", r.screen(cli))
	// a temp folder
	cliTempDirs = func() []string { return []string{filepath.Join(r.home, "scratch")} }
	tmp := filepath.Join(r.home, "scratch", "claude")
	require.NoError(t, os.MkdirAll(filepath.Dir(tmp), 0o755))
	require.NoError(t, os.WriteFile(tmp, []byte("#!/bin/sh\n"), 0o755))
	assert.Equal(t, "in a temporary folder", r.screen(tmp))
	// the wording names the agent, the folder as ~ and the way out
	why := r.screen(filepath.Join(r.home, "Downloads", "claude"))
	assert.True(t, strings.HasPrefix(why, "in an agent's working folder: "), why)
	assert.Contains(t, why, `"Dev team lead"`)
	assert.Contains(t, why, "works in ~")
	assert.NotContains(t, why, r.home, "the folder is written as ~, not the user's path")
	assert.Contains(t, why, "restart it in a project folder")
	assert.Contains(t, why, "an asleep one counts too")
}

func TestTheNotFoundAnswerSaysWhatItRefusedAndWhereItLooked(t *testing.T) {
	r := newNativeRig(t)
	t.Setenv("PATH", t.TempDir())
	// a claude that is refused (an agent works in ~/.local, below home) and nothing else: the answer names it and the places
	r.agentIn("aaaaaaaa-0000-4000-8000-000000000006", filepath.Join(r.home, ".local"))
	_, err := agent.LaunchCLIScreened(nil, "claude", r.screen)
	var nf *agent.CLINotFoundError
	require.ErrorAs(t, err, &nf)
	msg := nf.Error()
	assert.Contains(t, msg, "Coral found ~/.local/bin/claude and did not use it: it is in an agent's working folder")
	assert.Contains(t, msg, "~/.local/bin/claude", "the places it looked")
	assert.Contains(t, msg, "~/.claude/local/claude")
	assert.Contains(t, msg, "the PATH it runs with")
	assert.NotContains(t, msg, r.home, "paths are written with ~")
}

// fakeInfo is a FileInfo with the owner and mode a test chooses (the real files of a test are always the test's own).
type fakeInfo struct {
	mode os.FileMode
	uid  uint32
}

func (f fakeInfo) Name() string       { return "x" }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() os.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeInfo) Sys() any           { return &syscall.Stat_t{Uid: f.uid} }

// QA's SHOULD on #11454: another owner is refused, by fileOwnedByMe and in each of the checks that use it.
func TestAnotherOwnerIsRefusedByEveryCheckOfTheNativeInstallersFiles(t *testing.T) {
	me, other := uint32(os.Getuid()), uint32(os.Getuid()+1)
	assert.True(t, fileOwnedByMe(fakeInfo{0o755, me}))
	assert.False(t, fileOwnedByMe(fakeInfo{0o755, other}))
	assert.False(t, fileOwnedByMe(plainInfo{}), "an owner that cannot be read is nobody's")

	assert.True(t, privateRegularInfo(fakeInfo{0o755, me}))
	assert.False(t, privateRegularInfo(fakeInfo{0o755, other}), "a regular file somebody else owns")
	assert.False(t, privateRegularInfo(fakeInfo{0o775, me}), "group-writable")
	assert.False(t, privateRegularInfo(fakeInfo{0o757, me}), "world-writable")
	assert.False(t, privateRegularInfo(fakeInfo{os.ModeDir | 0o755, me}), "a folder is not a regular file")

	assert.True(t, privateDirInfo(fakeInfo{os.ModeDir | 0o755, me}))
	assert.False(t, privateDirInfo(fakeInfo{os.ModeDir | 0o755, other}), "a folder somebody else owns")
	assert.False(t, privateDirInfo(fakeInfo{os.ModeDir | 0o775, me}))
	assert.False(t, privateDirInfo(fakeInfo{0o755, me}), "a file is not a folder")
}

// plainInfo is a FileInfo with no system information.
type plainInfo struct{ fakeInfo }

func (plainInfo) Sys() any { return nil }

// QA's gap on #11467: the three parent folders are checked for a typed path under ~/.local/share/<cli>/versions/ too (the file itself, as the Settings check also looks at what a link resolves to), not
// only for the ~/.local/bin link.
func TestTheParentFoldersArePrivateForTheVersionFileTypedDirectlyToo(t *testing.T) {
	for name, parent := range map[string]func(r *nativeRig) string{
		"~/.local":              func(r *nativeRig) string { return filepath.Join(r.home, ".local") },
		"~/.local/share":        func(r *nativeRig) string { return filepath.Join(r.home, ".local", "share") },
		"~/.local/share/claude": func(r *nativeRig) string { return filepath.Join(r.home, ".local", "share", "claude") },
	} {
		for mode, perm := range map[string]os.FileMode{"group-writable": 0o775, "world-writable": 0o777} {
			t.Run(name+" "+mode, func(t *testing.T) {
				r := newNativeRig(t)
				r.agentIn("aaaaaaaa-0000-4000-8000-000000000007", r.home)
				require.Empty(t, r.screen(r.version), "untouched, the version file typed directly passes")
				require.NoError(t, os.Chmod(parent(r), perm))
				assert.NotEmpty(t, r.screen(r.version), "the parent folder is writable by others")
			})
		}
	}
}
