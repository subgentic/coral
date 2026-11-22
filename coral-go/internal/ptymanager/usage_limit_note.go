package ptymanager

import (
	"sync"
	"time"
)

// A screen read's finding of a usage limit, for the live row's blocked {kind: usage_limit} (#20692), as the model refusal's is (codex_model_refused.go): the health monitor reads the screens, the list reads this. resetAt is the zero time
// when the screen names no time.
type limitRead struct {
	resetAt time.Time
	at      time.Time
}

var limitReads sync.Map // session id -> limitRead

// NoteUsageLimit records what a screen read found for a session at `at`: a usage limit (resetAt zero when none is named), or none (which forgets an earlier one).
func NoteUsageLimit(sessionID string, limited bool, resetAt, at time.Time) {
	if !limited {
		limitReads.Delete(sessionID)
		return
	}
	limitReads.Store(sessionID, limitRead{resetAt: resetAt, at: at})
}

// UsageLimitOf is the limit the last screen read found for a session, when it was made within maxAge of now: an older read says nothing, so the mark goes by itself once nobody reads the screen.
func UsageLimitOf(sessionID string, maxAge time.Duration, now time.Time) (resetAt time.Time, ok bool) {
	v, found := limitReads.Load(sessionID)
	if !found {
		return time.Time{}, false
	}
	r := v.(limitRead)
	if now.Sub(r.at) > maxAge || !r.resetAt.IsZero() && !r.resetAt.After(now) { // an old read says nothing; a reset that has come is the limit over
		limitReads.Delete(sessionID)
		return time.Time{}, false
	}
	return r.resetAt, true
}
