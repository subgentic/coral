package apply

import (
	"os"
	"path/filepath"
)

// writable reports whether the user can create files next to the install and in it: the check before an update swaps the install (Mac and Linux).
func writable(install string) bool {
	for _, d := range []string{filepath.Dir(install), install} {
		f, err := os.CreateTemp(d, ".coral-update-probe-*")
		if err != nil {
			return false
		}
		name := f.Name()
		f.Close()
		os.Remove(name)
	}
	return true
}
