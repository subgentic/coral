package testtemp

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ownedByMe is always true on Windows: the system temp folder is the user's own (%LOCALAPPDATA%\Temp), and a TMP pointed elsewhere is
// the person's own choice of folder.
func ownedByMe(os.FileInfo) bool { return true }

// ownerOnly gives dir a protected access list that grants this user alone full control, inherited by what is made in it, when its list
// grants anyone else besides SYSTEM and Administrators: a TMP on a folder with a wider list (a shared drive's, which grants Authenticated
// Users or Users) would otherwise hand that list to the private folder and everything the tests write in it. changed says whether it did.
func ownerOnly(dir string) (changed bool, err error) {
	me, err := currentUser()
	if err != nil {
		return false, err
	}
	wider, err := widerThanOwner(dir, me)
	if err != nil || !wider {
		return false, err
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
		Trustee:           windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeType: windows.TRUSTEE_IS_USER, TrusteeValue: windows.TrusteeValueFromSID(me)},
	}}, nil)
	if err != nil {
		return false, err
	}
	err = windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
	return err == nil, err
}

func currentUser() (*windows.SID, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return u.User.Sid.Copy()
}

// widerThanOwner reports whether dir's access list allows anyone but me, SYSTEM and Administrators.
func widerThanOwner(dir string, me *windows.SID) (bool, error) {
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return false, err
	}
	if dacl == nil {
		return true, nil // no list at all: everyone has access
	}
	system, _ := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	admins, _ := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return false, err
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if sid.Equals(me) || (system != nil && sid.Equals(system)) || (admins != nil && sid.Equals(admins)) {
			continue
		}
		return true, nil
	}
	return false, nil
}
