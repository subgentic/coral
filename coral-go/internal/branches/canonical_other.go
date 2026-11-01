//go:build !windows

package branches

import "strings"

// platformCanonical is p as it is: links are already resolved, and names keep their case.
func platformCanonical(p string) string { return p }

// localFixedPath says p, as git listed it, is an absolute path that is not a //host form. Nothing at the path is touched.
func localFixedPath(p string) bool {
	return strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") && !strings.ContainsRune(p, 0)
}
