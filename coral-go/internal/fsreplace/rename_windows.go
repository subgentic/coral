package fsreplace

import (
	"errors"
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// rename is os.Rename over a file that may be open elsewhere. Go opens files on Windows without FILE_SHARE_DELETE, so a reader that has the destination open (the status the server asks the updater for,
// a virus scanner) makes the replace fail with a sharing violation or access denied until it lets go; a read is short, so the replace is tried again for about two seconds (#9738, the way cmd/go renames
// its files). Any other error, and the last one, is returned as it is.
func rename(from, to string) error {
	var err error
	for i, delay := 0, 5*time.Millisecond; i < 14; i++ {
		if err = os.Rename(from, to); err == nil || !busy(err) {
			return err
		}
		time.Sleep(delay)
		if delay < 250*time.Millisecond {
			delay *= 2
		}
	}
	return err
}

func busy(err error) bool {
	for _, e := range []windows.Errno{windows.ERROR_ACCESS_DENIED, windows.ERROR_SHARING_VIOLATION, windows.ERROR_LOCK_VIOLATION} {
		if errors.Is(err, syscall.Errno(e)) {
			return true
		}
	}
	return false
}
