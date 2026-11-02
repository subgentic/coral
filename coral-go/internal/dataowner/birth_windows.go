//go:build windows

package dataowner

import (
	"os"
	"syscall"
	"time"
)

// birthTime is when the file was created in this folder: the creation time. Copy tools (Explorer, robocopy /COPY:DAT, tar) keep the modified time and give the copy a NEW creation time.
func birthTime(fi os.FileInfo) (time.Time, bool) {
	d, ok := fi.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return time.Time{}, false
	}
	return time.Unix(0, d.CreationTime.Nanoseconds()), true
}
