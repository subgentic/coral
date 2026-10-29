//go:build !windows

package ptymanager

// startConsoleTripwire is Windows' check that no test opened a console window (console_windows_test.go); elsewhere there is none.
func startConsoleTripwire() func() []string { return func() []string { return nil } }
