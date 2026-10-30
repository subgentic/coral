//go:build !windows

package ptymanager

// expandShortDir: there are no 8.3 short names off Windows.
func expandShortDir(dir string) string { return dir }
