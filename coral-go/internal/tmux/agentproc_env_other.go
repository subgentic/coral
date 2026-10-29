//go:build !linux && !darwin

package tmux

// procEnvHasSession: this platform cannot read another process's environment here, so nothing is adopted by it.
func procEnvHasSession(pid int, session string) bool { return false }
