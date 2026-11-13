//go:build windows

package agent

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The sweep's ownership check on Windows (#357; before, it was `false` and the sweep kept every file, so a real Coral's launch files in %TEMP% were never cleaned). The rule, from
// Security's review:
//   - the file is opened WITHOUT following a link (FILE_FLAG_OPEN_REPARSE_POINT) and every decision is made on that handle, never on the path: a reparse point (a symlink or junction with a
//     Coral name) or a directory is not ours;
//   - the owner SID read from that handle must EQUAL the SID of the process token's user. Administrators, SYSTEM, any other owner, or any error means "not ours": the file is kept;
//   - the file is deleted through that same handle, so the object removed is the one that was checked, not whatever the path names a moment later;
//   - every other guard of the sweep (the exact name, the age, the live-session and running-process checks, the check just before removal) is unchanged.
//
// A file another process holds without sharing is kept, not an error.

// fileOwnerSID and currentUserSID are the lookups the check is made of (variables so the tests can put another owner in).
var (
	fileOwnerSID   = ownerSIDOfHandle
	currentUserSID = tokenUserSID
)

var errNotOurs = errors.New("not a regular file owned by this user")

func ownerSIDOfHandle(h windows.Handle) (*windows.SID, error) {
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return nil, err
	}
	owner, _, err := sd.Owner()
	return owner, err
}

func tokenUserSID() (*windows.SID, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return u.User.Sid, nil
}

// openNoFollow opens path for the given access without following a link: a reparse point is opened as itself.
func openNoFollow(path string, access uint32) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	return windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

// ourRegularFile decides on an open handle: a plain file (no reparse point, no directory) whose owner is the token's user.
func ourRegularFile(h windows.Handle) bool {
	var fi windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(h, &fi) != nil {
		return false
	}
	if fi.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return false
	}
	owner, err := fileOwnerSID(h)
	if err != nil || owner == nil {
		return false
	}
	me, err := currentUserSID()
	if err != nil || me == nil {
		return false
	}
	return windows.EqualSid(owner, me)
}

// ownedByCurrentUser: path is a plain file owned by this process's user, decided on a handle opened without following links.
func ownedByCurrentUser(path string, _ os.FileInfo) bool {
	h, err := openNoFollow(path, windows.READ_CONTROL)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	return ourRegularFile(h)
}

// removeOwnedFile checks the file again on a handle of its own and deletes it through that handle (POSIX delete semantics where the file system has them, else the classic delete
// disposition). A file that is not ours, or that another process holds open without sharing, is not removed.
func removeOwnedFile(path string) error {
	h, err := openNoFollow(path, windows.DELETE|windows.READ_CONTROL)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	if !ourRegularFile(h) {
		return errNotOurs
	}
	ex := struct{ Flags uint32 }{windows.FILE_DISPOSITION_DELETE | windows.FILE_DISPOSITION_POSIX_SEMANTICS}
	if err := windows.SetFileInformationByHandle(h, windows.FileDispositionInfoEx, (*byte)(unsafe.Pointer(&ex)), uint32(unsafe.Sizeof(ex))); err == nil {
		return nil
	}
	classic := struct{ DeleteFile uint8 }{1}
	return windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, (*byte)(unsafe.Pointer(&classic)), uint32(unsafe.Sizeof(classic)))
}
