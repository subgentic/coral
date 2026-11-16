package ptymanager

import (
	"strings"
	"sync"
	"time"
)

// A start that is scheduled but not yet typed (#18988). The team's starts are spaced (ReserveTeamStart), so a woken agent's pane sits at its shell for up to MaxStartWait before its CLI is typed
// into it; a reader of the pane (the reconciler) must not take that shell for an agent that exited. The server marks the session when it schedules the start and clears it when the line is typed;
// the mark also runs out by itself, so a start that never comes (a shutdown, a panic) cannot hold a session for ever.
var pendingStarts = struct {
	sync.Mutex
	until map[string]time.Time
}{until: map[string]time.Time{}}

// pendingStartSlack is how long past MaxStartWait a mark stands before it is dropped as lost.
const pendingStartSlack = 30 * time.Second

// pendingKey is the session a start target names: a pane id ("<session>.0") is the session's.
func pendingKey(target string) string {
	if i := strings.LastIndexByte(target, '.'); i > 0 {
		if rest := target[i+1:]; rest != "" && strings.Trim(rest, "0123456789") == "" {
			target = target[:i]
		}
	}
	return strings.ToLower(target)
}

// MarkStartPending records that a start for target (a session name, or its pane) will be typed later, and returns the function that clears it once it has been typed (or has failed).
func MarkStartPending(target string) (done func()) {
	key := pendingKey(target)
	deadline := time.Now().Add(MaxStartWait + pendingStartSlack)
	pendingStarts.Lock()
	pendingStarts.until[key] = deadline
	pendingStarts.Unlock()
	return func() {
		pendingStarts.Lock()
		defer pendingStarts.Unlock()
		if pendingStarts.until[key].Equal(deadline) { // a newer mark for the same session is not this one's to clear
			delete(pendingStarts.until, key)
		}
	}
}

// StartPending reports whether a start for the session is scheduled and not yet typed.
func StartPending(session string) bool {
	key := pendingKey(session)
	pendingStarts.Lock()
	defer pendingStarts.Unlock()
	until, ok := pendingStarts.until[key]
	if ok && time.Now().After(until) {
		delete(pendingStarts.until, key)
		return false
	}
	return ok
}
