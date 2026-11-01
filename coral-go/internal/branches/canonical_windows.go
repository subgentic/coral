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
