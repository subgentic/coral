package testtemp

import (
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// checkOutsideRoot is the rule for a root that is not directly in the profile (D:\coral-team-cache\<you>\ct): there is no profile folder to make another account's swap impossible, so the
// root itself must prove it (Security, #6656). It returns why the root cannot be used, or "" (making the root, with its access list set at creation, when it is missing).
//
//   - a plain drive-letter path (no \\?\, \\.\ or network form) on a local fixed volume that keeps access lists (no FAT, no removable or network drive, no subst), with a real parent folder
//     so the root is not the folder directly under a drive by accident;
//   - the root is made (or opened) with a protected access list that grants only this user, SYSTEM and Administrators, set AT creation, then read back from the open handle: a plain folder
//     (no reparse point), owned by this user's SID, protected (inheritance off), every allow entry one of those three;
//   - no link anywhere above it: the whole path resolves to itself;
//   - not inside or equal to the real ~/.coral, not inside the source tree being tested, and holding no .coral folder.
func checkOutsideRoot(clean string) string {
	if len(clean) < 4 || clean[1] != ':' || clean[2] != '\\' || !isLetter(clean[0]) {
		return "it is not a plain drive-letter path"
	}
	if filepath.Dir(filepath.Dir(clean)) == filepath.Dir(clean) {
		return "it has no real parent folder (it is directly under a drive)"
	}
	drive := clean[:2]
	vol, err := windows.UTF16PtrFromString(drive + `\`)
	if err != nil {
		return "it could not be read"
	}
	if windows.GetDriveType(vol) != windows.DRIVE_FIXED {
		return "its drive is not a local fixed drive"
	}
	var flags uint32
	if err := windows.GetVolumeInformation(vol, nil, 0, nil, nil, &flags, nil, 0); err != nil || flags&windows.FILE_PERSISTENT_ACLS == 0 {
		return "its drive does not keep access lists"
	}
	if dev, err := windows.UTF16PtrFromString(drive); err == nil {
		buf := make([]uint16, 1024)
		if n, err := windows.QueryDosDevice(dev, &buf[0], uint32(len(buf))); err == nil && n > 0 && strings.HasPrefix(windows.UTF16ToString(buf), `\??\`) {
			return "its drive is a substituted folder"
		}
	}
	if fi, err := os.Lstat(filepath.Dir(clean)); err != nil || fi.Mode().Type() != os.ModeDir {
		return "its parent folder is not a real folder"
	}
	me, err := currentUser()
	if err != nil {
		return "the current user is not known"
	}
	if err := createOwnerOnly(clean, me); err != nil {
		return "it could not be made"
	}
	if reason := checkRootFolder(clean, me); reason != "" {
		return reason
	}
	real, err := filepath.EvalSymlinks(clean)
	if err != nil || !strings.EqualFold(real, clean) {
		return "a link or junction is in its path"
	}
	return notProtectedData(real)
}

func isLetter(b byte) bool { return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' }

// ownerOnlySDDL is the protected list a root or private folder is made with: this user, SYSTEM and Administrators, inherited by what is made inside.
func ownerOnlySDDL(me *windows.SID) string {
	return "D:P(A;OICI;GA;;;" + me.String() + ")(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)"
}

func ownerOnlyAttributes(me *windows.SID) (*windows.SecurityAttributes, error) {
	sd, err := windows.SecurityDescriptorFromString(ownerOnlySDDL(me))
	if err != nil {
		return nil, err
	}
	return &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}, nil
}

// createOwnerOnly makes dir with the owner-only protected list set at creation, so there is no window with a wider one. A folder that already exists is not an error (parallel test binaries
// race to make the root): the caller checks what it finds.
func createOwnerOnly(dir string, me *windows.SID) error {
	sa, err := ownerOnlyAttributes(me)
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	if err := windows.CreateDirectory(p, sa); err != nil && err != windows.ERROR_ALREADY_EXISTS {
		return err
	}
	return nil
}

// makePrivateDir makes a new ct-N folder under base with the owner-only list set at creation (a random name, retried when taken), and reads the list back.
func makePrivateDir(base string) (string, error) {
	me, err := currentUser()
	if err != nil {
		return "", err
	}
	sa, err := ownerOnlyAttributes(me)
	if err != nil {
		return "", err
	}
	for i := 0; i < 100; i++ {
		dir := filepath.Join(base, privateNamePrefix+randomDigits())
		p, err := windows.UTF16PtrFromString(dir)
		if err != nil {
			return "", err
		}
		err = windows.CreateDirectory(p, sa)
		if err == windows.ERROR_ALREADY_EXISTS {
			continue
		}
		if err != nil {
			return "", err
		}
		if !ownerOnlyAcl(dir) || !ownedByMe(dir, nil) {
			os.Remove(dir)
			return "", windows.ERROR_ACCESS_DENIED
		}
		return dir, nil
	}
	return "", os.ErrExist
}

// checkRootFolder opens the root itself (no link followed) and reads what it is and who may use it from that handle.
func checkRootFolder(dir string, me *windows.SID) string {
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return "it could not be read"
	}
	h, err := windows.CreateFile(p, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return "it could not be opened"
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return "it could not be read"
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return "it is not a real folder (a file, link or junction)"
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return "its access list could not be read"
	}
	return checkDescriptor(sd, me)
}

// checkDescriptor is the owner and access-list test: owned by me, a protected list, and every allow entry me, SYSTEM or Administrators. A deny entry is not a reason to refuse.
func checkDescriptor(sd *windows.SECURITY_DESCRIPTOR, me *windows.SID) string {
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !owner.Equals(me) {
		return "it is not owned by this user"
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return "its access list inherits from above (it is not protected)"
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return "its access list is missing"
	}
	system, _ := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	admins, _ := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return "its access list could not be read"
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.Equals(me) && (system == nil || !sid.Equals(system)) && (admins == nil || !sid.Equals(admins)) {
			return "its access list grants others"
		}
	}
	return ""
}
