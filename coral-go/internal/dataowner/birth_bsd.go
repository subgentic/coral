//go:build darwin || freebsd

package dataowner

import (
	"os"
	"syscall"
	"time"
)

// birthTime is the changed time (ctime): a copy that keeps the modified time still has a new ctime, and no ordinary call sets it backwards.
func birthTime(fi os.FileInfo) (time.Time, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return time.Time{}, false
	}
	return time.Unix(int64(st.Ctimespec.Sec), int64(st.Ctimespec.Nsec)), true
}
