package ptymanager

import (
	"sync"
	"time"
)

// limitResumes is when Coral will resume each agent that a usage limit stopped (the resumer in background sets it, the live list reads it, #20691). Only a time per session id; an entry is forgotten
// when the resume is sent, cancelled or no longer wanted.
var limitResumes sync.Map // session id -> time.Time

// NoteLimitResume records that sessionID will be resumed at at; the zero time forgets it.
func NoteLimitResume(sessionID string, at time.Time) {
	if at.IsZero() {
		limitResumes.Delete(sessionID)
		return
	}
	limitResumes.Store(sessionID, at)
}

// LimitResumeAt is when sessionID will be resumed, when a resume is pending.
func LimitResumeAt(sessionID string) (time.Time, bool) {
	v, ok := limitResumes.Load(sessionID)
	if !ok {
		return time.Time{}, false
	}
	return v.(time.Time), true
}
