//go:build !darwin

package procspawn

// Supported is false: only macOS attributes processes to a responsible one.
func Supported() bool { return false }

// Spawn is not available here: the caller starts the process itself.
func Spawn(string, []string, Options) (int, error) { return 0, ErrUnsupported }
