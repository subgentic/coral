//go:build !windows && !linux && !darwin && !freebsd

package dataowner

import (
	"os"
	"time"
)

// birthTime: this system gives no creation or changed time here, so no file predates anything (the foreign side).
func birthTime(os.FileInfo) (time.Time, bool) { return time.Time{}, false }
