//go:build !windows

package opencode

import "errors"

// systemListenerPIDs is Windows' listener table; elsewhere listenerPIDs asks lsof or ss and never calls it.
func systemListenerPIDs(int) ([]int, error) {
	return nil, errors.New("the system listener table is read only on Windows")
}
