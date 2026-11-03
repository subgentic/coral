//go:build !windows

package secfile

import "runtime"

// isSystemAdminGroup says whether gid is the group of the computer's administrators, whose members the system lets become root (macOS: "admin", gid 80; /Applications is root:admin 0775 on every Mac). A group write
// bit of that group on a folder root owns is the system's own arrangement, not a hole: a variable so a test can name one on any system. Other systems have no such group here, so nothing else is trusted (#12656).
var isSystemAdminGroup = func(gid uint32) bool {
	return runtime.GOOS == "darwin" && gid == 80 && groupName(gid) == "admin"
}
