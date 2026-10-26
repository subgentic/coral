//go:build windows

package winuser

import "golang.org/x/sys/windows"

// CurrentSID is this process's user (never the token's default owner, which is Administrators for an elevated process). The SID is a copy the
// caller owns.
func CurrentSID() (*windows.SID, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return u.User.Sid.Copy()
}
