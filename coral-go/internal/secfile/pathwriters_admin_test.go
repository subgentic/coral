//go:build !windows

package secfile

import (
	"io/fs"
	"os"
	"runtime"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A fake chain on a Mac (#12656): /Applications is root:admin 0775 on every Mac, so Coral's own hook, in a root-owned bundle under it, was refused with "its group (admin) can write in /Applications" for every normal
// install. The admin group is the one macOS lets become root, so a root-owned folder its members can write is the system's own; a user-writable or world-writable folder, and any other group, still count.
type fakeInfo struct {
	mode os.FileMode
	sys  *syscall.Stat_t
}

func (f fakeInfo) Name() string       { return "x" }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeInfo) Sys() any           { return f.sys }

func adminRig(t *testing.T, groupOK func(uint32) (bool, error)) *walker {
	t.Helper()
	prevACL, prevAdmin := readACL, isSystemAdminGroup
	readACL = func(string, int, string) ([]string, error) { return nil, nil }
	isSystemAdminGroup = func(gid uint32) bool { return gid == 80 }
	t.Cleanup(func() { readACL, isSystemAdminGroup = prevACL, prevAdmin })
	return &walker{uid: 501, who: map[string]Writer{}, acl: map[string][]string{}, groupOK: groupOK}
}

func dirInfo(perm os.FileMode, uid, gid uint32) fakeInfo {
	return fakeInfo{mode: os.ModeDir | perm, sys: &syscall.Stat_t{Uid: uid, Gid: gid}}
}

func TestRootsAdminGroupWritingInApplicationsIsTheSystemsOwnAndNotAFinding(t *testing.T) {
	w := adminRig(t, func(uint32) (bool, error) { return false, nil })
	// /Applications root:admin 0775 -> the bundle root 0755 -> the hook
	require.NoError(t, w.folderWriters("/Applications", dirInfo(0o775, 0, 80), dirInfo(0o755, 0, 0)))
	assert.Empty(t, w.who, "root:admin 0775 is the system's own")
}

func TestOtherWritableFoldersOfThatChainStillCount(t *testing.T) {
	cases := map[string]fakeInfo{
		"a root folder another group can write":     dirInfo(0o775, 0, 20),
		"a root folder everyone can write":          dirInfo(0o777, 0, 80),
		"a folder of another user, admin can write": dirInfo(0o775, 502, 80),
	}
	for name, info := range cases {
		w := adminRig(t, func(uint32) (bool, error) { return false, nil })
		require.NoError(t, w.folderWriters("/Applications", info, dirInfo(0o755, 0, 0)))
		assert.NotEmpty(t, w.who, name)
	}
	// And a walker that never trusts a group (the strict PathWriters) does not take admin as root's either.
	strict := adminRig(t, nil)
	require.NoError(t, strict.folderWriters("/Applications", dirInfo(0o775, 0, 80), dirInfo(0o755, 0, 0)))
	assert.NotEmpty(t, strict.who, "no group check, no trust")
}

func TestTheUsersOwnGroupRuleIsUnchanged(t *testing.T) {
	w := adminRig(t, func(gid uint32) (bool, error) { return gid == 20, nil })
	require.NoError(t, w.folderWriters("/Users/me/tools", dirInfo(0o775, 501, 20), dirInfo(0o755, 501, 20)))
	assert.Empty(t, w.who, "the user's own folder with the user's own group")
	w2 := adminRig(t, func(gid uint32) (bool, error) { return false, nil })
	require.NoError(t, w2.folderWriters("/Users/me/tools", dirInfo(0o775, 501, 20), dirInfo(0o755, 501, 20)))
	assert.NotEmpty(t, w2.who)
}

// The real rule, not the test's stand-in: only macOS's admin group (gid 80, named admin) is the system's administrators; no other group, and no other system, is.
func TestOnlyMacOSAdminGroupIsTheSystemAdminGroup(t *testing.T) {
	if runtime.GOOS != "darwin" {
		assert.False(t, isSystemAdminGroup(80), "other systems trust no group here")
		return
	}
	assert.True(t, isSystemAdminGroup(80), "admin (gid 80)")
	for _, gid := range []uint32{0, 20, 501, 79, 81} { // wheel, staff, a user's own, its neighbours
		assert.False(t, isSystemAdminGroup(gid), "gid %d is not the administrators' group", gid)
	}
}
