//go:build windows

package main

import (
	"time"

	"golang.org/x/sys/windows"
)

// showTermsNeededNote shows the note in a message box (coral.exe has a console only when something gave it one: a start from a scheduled task or a launcher has none). The box is
// shown on its own goroutine and waited for at most a minute, so a session nobody can see (a service) does not hold the program for ever.
func showTermsNeededNote() {
	t, err1 := windows.UTF16PtrFromString(termsNeededNoteTitle)
	m, err2 := windows.UTF16PtrFromString(termsNeededNote)
	if err1 != nil || err2 != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONINFORMATION|windows.MB_SETFOREGROUND)
	}()
	select {
	case <-done:
	case <-time.After(time.Minute):
	}
}
