//go:build windows

package branches

import (
	"strings"

	"golang.org/x/sys/windows"
)

// platformCanonical is p's long name (an 8.3 name such as CKNOR~1 expanded) in lower case: Windows compares folder names without case, and an agent's folder may be given either way.
func platformCanonical(p string) string {
	if in, err := windows.UTF16PtrFromString(p); err == nil {
		buf := make([]uint16, windows.MAX_LONG_PATH)
		if n, err := windows.GetLongPathName(in, &buf[0], uint32(len(buf))); err == nil && n > 0 && int(n) < len(buf) {
			p = windows.UTF16ToString(buf[:n])
		}
	}
	return strings.ToLower(p)
}

// localFixedPath says p, as git listed it, is a plain folder on a local fixed drive ("C:\..." or "C:/..."): not a network share (\\host\share, //host/share), not a \\?\ or \\.\ form,
// not a mapped network, removable or optical drive. Only such a path is resolved, opened or run in (Security's SHOULD 1 on #272: anything else could make Windows authenticate to
// another host). It is decided from the text and the drive's type; nothing at the path is touched.
func localFixedPath(p string) bool {
	if len(p) < 3 || !(p[0] >= 'A' && p[0] <= 'Z' || p[0] >= 'a' && p[0] <= 'z') || p[1] != ':' || (p[2] != '\\' && p[2] != '/') {
		return false
	}
	if strings.ContainsAny(p, "\x00") {
		return false
	}
	root, err := windows.UTF16PtrFromString(p[:2] + `\`)
	if err != nil {
		return false
	}
	return windows.GetDriveType(root) == windows.DRIVE_FIXED
}
