//go:build windows

package agent

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/linktest"
)

// #357: the sweep on Windows removes a real Coral's old launch files, by the rule in tempsweep_owner_windows.go: decided on a handle opened without following links, the owner's SID
// equal to the token user's, deleted through that handle. Everything else about which file goes is the common sweep's.

const (
	winDeadSID = "55555555-5555-4555-8555-555555555555"
	winOldAge  = 25 * time.Hour
)

func sweepOpts() TempSweep {
	return TempSweep{
		MinAge:  time.Hour,
		Live:    func(string) bool { return false },
		Running: func() (string, error) { return "some other process", nil },
	}
}

func agedFile(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	require.NoError(t, os.WriteFile(p, []byte("x"), 0o600))
	old := time.Now().Add(-winOldAge)
	require.NoError(t, os.Chtimes(p, old, old))
	return p
}

func present(p string) bool { _, err := os.Lstat(p); return err == nil }

// The real case: a file this test creates, old enough, not live, named like a launch file, is removed. The file's owner is whatever Windows gave it; a process whose new files are owned by
// Administrators (an elevated token) owns nothing by the SID rule, and then the file is kept: the rule is "the owner equals the token user", and the test says which of the two it saw.
func TestWindowsSweepRemovesAnOldFileOfTheCurrentUser(t *testing.T) {
	dir := t.TempDir()
	p := agedFile(t, dir, "coral_prompt_"+winDeadSID+"_123.txt")
	h, err := openNoFollow(p, windows.READ_CONTROL)
	require.NoError(t, err)
	owner, oerr := fileOwnerSID(h)
	windows.CloseHandle(h)
	require.NoError(t, oerr)
	me, merr := currentUserSID()
	require.NoError(t, merr)
	ours := windows.EqualSid(owner, me)
	t.Logf("the new file's owner is the token user: %v (owner %s, user %s)", ours, owner, me)

	removed := SweepStaleTempFiles(dir, sweepOpts())
	if ours {
		assert.Equal(t, []string{p}, removed)
		assert.False(t, present(p), "removed through the handle")
	} else {
		assert.Empty(t, removed, "an owner that is not the token user (Administrators on an elevated token) is kept")
		assert.True(t, present(p))
	}
}

// Every other guard still holds with the owner check in: a young file, a live session, a name that is not exactly a launch file's stay.
func TestWindowsSweepStillKeepsWhatTheOtherGuardsKeep(t *testing.T) {
	dir := t.TempDir()
	young := filepath.Join(dir, "coral_prompt_"+winDeadSID+"_1.txt")
	require.NoError(t, os.WriteFile(young, []byte("x"), 0o600))
	other := agedFile(t, dir, "coral_notes_"+winDeadSID+"_2.txt")
	live := agedFile(t, dir, "coral_prompt_66666666-6666-4666-8666-666666666666_3.txt")
	opt := sweepOpts()
	opt.Live = func(id string) bool { return id == "66666666-6666-4666-8666-666666666666" }
	assert.Empty(t, SweepStaleTempFiles(dir, opt))
	for _, p := range []string{young, other, live} {
		assert.True(t, present(p), p)
	}
}

// A file whose owner is not the token user is kept.
func TestWindowsSweepKeepsAFileAnotherOwnerHas(t *testing.T) {
	dir := t.TempDir()
	p := agedFile(t, dir, "coral_prompt_"+winDeadSID+"_123.txt")
	prev := fileOwnerSID
	t.Cleanup(func() { fileOwnerSID = prev })
	system, err := windows.StringToSid("S-1-5-18") // SYSTEM
	require.NoError(t, err)
	fileOwnerSID = func(windows.Handle) (*windows.SID, error) { return system, nil }
	assert.Empty(t, SweepStaleTempFiles(dir, sweepOpts()))
	assert.True(t, present(p), "owned by SYSTEM in the lookup: not ours")

	// A failed owner lookup means "not ours" too.
	fileOwnerSID = func(windows.Handle) (*windows.SID, error) { return nil, windows.ERROR_ACCESS_DENIED }
	assert.Empty(t, SweepStaleTempFiles(dir, sweepOpts()))
	assert.True(t, present(p))
}

// A link with a Coral name is never followed or removed as a file of ours: the check refuses a reparse point, and the target is untouched.
func TestWindowsSweepNeverFollowsAReparsePoint(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "victim.txt")
	require.NoError(t, os.WriteFile(target, []byte("precious"), 0o600))
	link := filepath.Join(dir, "coral_prompt_"+winDeadSID+"_123.txt")
	linktest.Symlink(t, target, link)
	old := time.Now().Add(-winOldAge)
	_ = os.Chtimes(target, old, old)
	info, err := os.Lstat(link)
	require.NoError(t, err)
	assert.False(t, ownedByCurrentUser(link, info), "a reparse point is not ours")
	assert.Empty(t, SweepStaleTempFiles(dir, sweepOpts()))
	assert.True(t, present(link))
	b, err := os.ReadFile(target)
	require.NoError(t, err)
	assert.Equal(t, "precious", string(b), "the target is untouched")
	assert.Error(t, removeOwnedFile(link), "removeOwnedFile refuses a reparse point")
	assert.True(t, present(link))
}

// A folder with a Coral name is not a file of ours.
func TestWindowsSweepKeepsAFolderWithACoralName(t *testing.T) {
	dir := t.TempDir()
	d := filepath.Join(dir, "coral_prompt_"+winDeadSID+"_123.txt")
	require.NoError(t, os.Mkdir(d, 0o700))
	old := time.Now().Add(-winOldAge)
	require.NoError(t, os.Chtimes(d, old, old))
	assert.Empty(t, SweepStaleTempFiles(dir, sweepOpts()))
	assert.True(t, present(d))
	assert.Error(t, removeOwnedFile(d))
	assert.True(t, present(d))
}

// A file another process holds without sharing is kept, and is not an error: once it is closed the next sweep removes it.
func TestWindowsSweepKeepsALockedFileAndTakesItOnceItIsFree(t *testing.T) {
	dir := t.TempDir()
	p := agedFile(t, dir, "coral_prompt_"+winDeadSID+"_123.txt")
	h, err := openNoFollow(p, windows.READ_CONTROL)
	require.NoError(t, err)
	ownerSID, oerr := fileOwnerSID(h)
	windows.CloseHandle(h)
	require.NoError(t, oerr)
	me, _ := currentUserSID()
	elevated := !windows.EqualSid(ownerSID, me) // an elevated token's new files are owned by Administrators: the sweep keeps them, locked or not
	pp, err := windows.UTF16PtrFromString(p)
	require.NoError(t, err)
	lock, err := windows.CreateFile(pp, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0) // share mode 0: nobody else may open it
	require.NoError(t, err)
	assert.Empty(t, SweepStaleTempFiles(dir, sweepOpts()), "locked: kept")
	assert.True(t, present(p))
	windows.CloseHandle(lock)
	if elevated {
		assert.Empty(t, SweepStaleTempFiles(dir, sweepOpts()), "free but owned by a group: kept")
		return
	}
	assert.Equal(t, []string{p}, SweepStaleTempFiles(dir, sweepOpts()), "free: removed")
}

// The same, without the symlink privilege: a junction (a reparse point that is also a folder) with a Coral name is kept, and what it leads to is untouched.
func TestWindowsSweepKeepsAJunctionWithACoralName(t *testing.T) {
	dir := t.TempDir()
	target := t.TempDir()
	precious := filepath.Join(target, "precious.txt")
	require.NoError(t, os.WriteFile(precious, []byte("precious"), 0o600))
	junction := filepath.Join(dir, "coral_prompt_"+winDeadSID+"_123.txt")
	out, err := exec.Command("cmd", "/c", "mklink", "/J", junction, target).CombinedOutput()
	require.NoError(t, err, "mklink /J: %s", out)
	old := time.Now().Add(-winOldAge)
	_ = os.Chtimes(junction, old, old) // best effort: a junction can't always be opened to set its time, so the guard is also asserted directly below
	info, err := os.Lstat(junction)
	require.NoError(t, err)
	assert.False(t, ownedByCurrentUser(junction, info), "a reparse point is not ours, whatever its age")
	assert.Empty(t, SweepStaleTempFiles(dir, sweepOpts()))
	assert.True(t, present(junction), "the junction is kept")
	assert.Error(t, removeOwnedFile(junction))
	b, err := os.ReadFile(precious)
	require.NoError(t, err)
	assert.Equal(t, "precious", string(b), "what it leads to is untouched")
}
