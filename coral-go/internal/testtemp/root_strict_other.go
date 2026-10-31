//go:build !windows

package testtemp

import "os"

// checkOutsideRoot: a root outside the profile folder is for Windows, where the profile rule cannot hold (D:); elsewhere the profile root and /tmp serve.
func checkOutsideRoot(string) string { return "a root elsewhere is for Windows only" }

func makePrivateDir(base string) (string, error) { return os.MkdirTemp(base, privateNamePrefix) }
