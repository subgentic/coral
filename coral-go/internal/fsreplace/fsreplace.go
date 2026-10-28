// Package fsreplace renames a file over an existing one, the step that ends every write-to-a-temp-then-rename in the module.
package fsreplace

// Rename is os.Rename for a destination that may exist and be open elsewhere. On Unix and on a destination nobody has open it is os.Rename; on Windows it waits out a reader (see rename_windows.go).
// Every atomic write in the module ends in it: a bare os.Rename over an existing file is refused by TestNoBareRename (#9738).
func Rename(from, to string) error { return rename(from, to) }
