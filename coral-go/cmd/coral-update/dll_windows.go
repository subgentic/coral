//go:build windows

package main

import "golang.org/x/sys/windows"

// The dashboard runs this program from a COPY in <data>/updates/apply (trigger.Launch), a folder this user can write to, and it decides what Windows Installer
// may replace. A DLL the program loads by a bare name is searched for in the program's own folder first: a file planted beside the copy would run in it. From here on
// every load, whatever asks for it (this program's packages, a library, the Go runtime's late loads), searches the system folder only
// (LOAD_LIBRARY_SEARCH_SYSTEM32). No package of this program loads a DLL by a bare name anyway (internal/testguard's census holds that); this is the process-wide
// second lock, set in the first init of the main package, after the packages it imports have initialised (none of them loads a DLL at init).
func init() {
	dllLockErr = windows.SetDefaultDllDirectories(windows.LOAD_LIBRARY_SEARCH_SYSTEM32)
	dllSearchLocked = dllLockErr == nil
}

// dllSearchLocked says whether the lock took (a test reads it).
var dllSearchLocked bool
