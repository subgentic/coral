//go:build !windows

package testtemp

// hold does nothing off Windows: a folder there is removed whatever is open in it, so a handle would protect nothing.
func hold(dirs ...string) (release func()) { return func() {} }
