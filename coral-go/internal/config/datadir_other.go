//go:build !windows

package config

// protectDataDir: on Unix the folder's 0700 mode is the protection.
func protectDataDir(string) error { return nil }

// untrustedMountRefusal: only Windows refuses to traverse a junction (error 448).
func untrustedMountRefusal(error) bool { return false }

// secureExistingDataDir: on Unix an existing folder's mode is tightened by the server's permission pass (data_perms.go).
func secureExistingDataDir(string) (string, error) { return "", nil }

// DataDirBroadReaders: on Unix the mode is checked (and tightened) by the server's permission
// pass; nothing to report here.
func DataDirBroadReaders(string) ([]string, error) { return nil, nil }
