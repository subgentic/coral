//go:build !windows

package consoletest

// startTripwire: only Windows hands a console program a console window.
func startTripwire() func() []string { return func() []string { return nil } }

func printTripwire([]string) {}
