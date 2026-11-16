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
	typed map[string]time.Time // when a start was last typed (or gave up): the exit grace runs from here, not from when it was scheduled
}{until: map[string]time.Time{}, typed: map[string]time.Time{}}

// pendingStartSlack is how long past the start's own delay a mark stands before it is dropped as lost.
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

// typedKeep is how long a typed time is remembered: well past any exit grace.
const typedKeep = 10 * time.Minute

// MarkStartPending records that a start for target (a session name, or its pane) will be typed in d (the delay it was given, which the Codex first-start gap can make longer than MaxStartWait), and
// returns the function that clears it once it has been typed (or has failed) and notes the time.
func MarkStartPending(target string, d time.Duration) (done func()) {
	key := pendingKey(target)
	if d < MaxStartWait {
		d = MaxStartWait
	}
	deadline := time.Now().Add(d + pendingStartSlack)
	pendingStarts.Lock()
	pendingStarts.until[key] = deadline
	pendingStarts.Unlock()
	return func() {
		pendingStarts.Lock()
		defer pendingStarts.Unlock()
		if pendingStarts.until[key].Equal(deadline) { // a newer mark for the same session is not this one's to clear
			delete(pendingStarts.until, key)
			now := time.Now()
			for k, t := range pendingStarts.typed {
				if now.Sub(t) > typedKeep {
					delete(pendingStarts.typed, k)
				}
			}
			pendingStarts.typed[key] = now
		}
	}
}

// StartTypedAt is when the session's last scheduled start was typed, if this process typed one lately: the launch is that old, whatever its row says (a spaced start is stamped when scheduled).
func StartTypedAt(session string) (time.Time, bool) {
	pendingStarts.Lock()
	defer pendingStarts.Unlock()
	t, ok := pendingStarts.typed[pendingKey(session)]
	return t, ok
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
