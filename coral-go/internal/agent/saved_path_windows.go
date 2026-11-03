//go:build windows

package agent

import (
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

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
