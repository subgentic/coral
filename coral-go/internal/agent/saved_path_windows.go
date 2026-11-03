//go:build windows

package agent

import (
	"path/filepath"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// isLocalDrive: the root's drive type is fixed, removable, CD-ROM or RAM disk. A mapped share (DRIVE_REMOTE), an unknown type and a root that does not exist are not.
func isLocalDrive(root string) bool {
	p, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return false
	}
	switch windows.GetDriveType(p) {
	case windows.DRIVE_FIXED, windows.DRIVE_REMOVABLE, windows.DRIVE_CDROM, windows.DRIVE_RAMDISK:
		return true
	}
	return false
}

// savedPathDirs is the Path Windows gives a new process: the system's (HKLM\...\Session Manager\Environment) then the person's (HKCU\Environment), each expanded when it is
// REG_EXPAND_SZ. A value that can't be read is left out.
func savedPathDirs() []string {
	var dirs []string
	for _, k := range []struct {
		root registry.Key
		path string
	}{
		{registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`},
		{registry.CURRENT_USER, `Environment`},
	} {
		key, err := registry.OpenKey(k.root, k.path, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		v, typ, err := key.GetStringValue("Path")
		key.Close()
		if err != nil {
			continue
		}
		if typ == registry.EXPAND_SZ {
			if x, xerr := registry.ExpandString(v); xerr == nil {
				v = x
			}
		}
		dirs = append(dirs, filepath.SplitList(v)...)
	}
	return dirs
}
