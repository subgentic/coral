//go:build !windows

package fsreplace

import "os"

func rename(from, to string) error { return os.Rename(from, to) }
