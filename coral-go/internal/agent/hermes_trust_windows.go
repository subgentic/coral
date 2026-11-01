//go:build windows

package agent

import "errors"

// hermesToolTrusted: Hermes on Windows has not been tried with Coral (#11715), so no hook is installed there.
func hermesToolTrusted(string) error { return errors.New("Hermes hooks are not installed on Windows") }
