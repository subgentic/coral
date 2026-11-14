//go:build windows

package routes

import "time"

// processCPU: Windows has no getrusage; the walk's wall clock is used there, as before (#16035).
func processCPU() (time.Duration, bool) { return 0, false }
