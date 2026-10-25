//go:build !windows

package startup

import (
	"context"
	"errors"
)

// windowsCommandLines exists on every platform so runningCommandLines compiles; only Windows reaches it.
func windowsCommandLines(context.Context) (string, error) {
	return "", errors.New("the Windows process list is Windows'")
}
