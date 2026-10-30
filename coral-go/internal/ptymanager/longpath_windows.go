//go:build windows

package ptymanager

import (
	"path/filepath"

	"golang.org/x/sys/windows"
)

// expandShortDir is dir ("/" separators) with its 8.3 short names expanded, or dir itself when it cannot be (the folder is gone); the answer has "/" separators too.
func expandShortDir(dir string) string {
	in, err := windows.UTF16PtrFromString(filepath.FromSlash(dir))
	if err != nil {
		return dir
	}
	buf := make([]uint16, 1024)
	n, err := windows.GetLongPathName(in, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 || int(n) > len(buf) {
		return dir
	}
	return filepath.ToSlash(windows.UTF16ToString(buf[:n]))
}
