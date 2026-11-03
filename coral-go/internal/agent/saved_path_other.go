//go:build !windows

package agent

// savedPathDirs: on macOS and Linux the PATH a person sees comes from their shell's startup files, which Coral does not run (CommonPlaceLookup); there is no saved Path to read.
func savedPathDirs() []string { return nil }
