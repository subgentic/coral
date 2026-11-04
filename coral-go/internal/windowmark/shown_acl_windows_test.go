//go:build windows

package windowmark

import (
	"path/filepath"
	"testing"
	"unsafe"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"
)

// The record is created owner-only (coral-hub QA's SHOULD on #290, Windows' form of 0600): its access list is protected (nothing inherited from the folder) and grants
// only this user and SYSTEM, as secfile.OpenNoFollow sets it on the handle at create. A create that kept the folder's inherited list fails here.
func TestTheShownOnceRecordIsCreatedOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	NoteShown(dir)
	sd, err := windows.GetNamedSecurityInfo(filepath.Join(dir, ShownFileName), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	require.NoError(t, err)
	control, _, err := sd.Control()
	require.NoError(t, err)
	assert.NotZero(t, control&windows.SE_DACL_PROTECTED, "the access list is the record's own, not inherited")
	dacl, _, err := sd.DACL()
	require.NoError(t, err)
	require.NotNil(t, dacl)

	tok := windows.GetCurrentProcessToken()
	u, err := tok.GetTokenUser()
	require.NoError(t, err)
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	require.NoError(t, err)
	var granted []string
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		require.NoError(t, windows.GetAce(dacl, i, &ace))
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		granted = append(granted, sid.String())
		assert.True(t, sid.Equals(u.User.Sid) || sid.Equals(system), "only this user and SYSTEM: %s", sid.String())
	}
	assert.Contains(t, granted, u.User.Sid.String(), "this user can use it")
}
