//go:build darwin

package appdownload

import (
	"fmt"
	"time"

	"golang.org/x/sys/unix"
)

// markDownloaded gives the file the com.apple.quarantine attribute a browser or WKDownload gives a download, so Gatekeeper asks before an app, a script or a
// .terminal file saved this way is opened (#9894, Security Reviewer). Best effort: a volume without extended attributes just leaves the file unmarked.
func markDownloaded(path string) {
	value := fmt.Sprintf("0081;%x;Coral;", time.Now().Unix())
	_ = unix.Setxattr(path, "com.apple.quarantine", []byte(value), 0)
}

// quarantineOf reads the attribute back (the tests).
func quarantineOf(path string) (string, bool) {
	buf := make([]byte, 256)
	n, err := unix.Getxattr(path, "com.apple.quarantine", buf)
	if err != nil {
		return "", false
	}
	return string(buf[:n]), true
}
