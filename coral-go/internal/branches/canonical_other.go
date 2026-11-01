//go:build !windows

package branches

// platformCanonical is p as it is: links are already resolved, and names keep their case.
func platformCanonical(p string) string { return p }
