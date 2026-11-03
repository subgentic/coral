package dataowner

import (
	"context"
	"sync"
)

// The warning a start leaves for the dashboard when the ids show a copy (#12591): Coral runs as usual, and the person may press "This is my data folder" to adopt the folder in place. The text is
// the fixed Notice, never built from file content. One warning per process, set at startup, cleared when the folder is adopted.
var (
	warnMu  sync.Mutex
	warning string
	adopter func(context.Context) error
)

// SetCopyWarning records the warning and the function that adopts the folder in place (the database's row and the folder's file, as coral --adopt-data-dir does), at startup.
func SetCopyWarning(text string, adopt func(context.Context) error) {
	warnMu.Lock()
	defer warnMu.Unlock()
	warning, adopter = text, adopt
}

// CopyWarning is the warning to show, or "" when there is none.
func CopyWarning() string {
	warnMu.Lock()
	defer warnMu.Unlock()
	return warning
}

// AdoptPending adopts the folder in place and clears the warning. It reports whether there was a warning to answer: false (and no error) when there was none, so a second press does nothing.
func AdoptPending(ctx context.Context) (bool, error) {
	warnMu.Lock()
	defer warnMu.Unlock()
	if warning == "" || adopter == nil {
		return false, nil
	}
	if err := adopter(ctx); err != nil {
		return true, err
	}
	warning, adopter = "", nil
	return true, nil
}

// ResetCopyWarningForTest clears the warning and the adopter: only for tests.
func ResetCopyWarningForTest() {
	warnMu.Lock()
	defer warnMu.Unlock()
	warning, adopter = "", nil
}
