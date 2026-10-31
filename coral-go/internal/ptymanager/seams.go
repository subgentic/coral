package ptymanager

import (
	"sync/atomic"
	"time"
)

// waitTimings are the waits of the gate and of a prompt that a test shortens. They are one value behind an atomic pointer, read once
// per use through waits(): a goroutine an earlier test left running (the gate's retry loop is one for the whole process) may read
// them while the next test sets its own or the cleanup of the last puts them back, and a plain package variable made that a data
// race under -race (#5266). A test replaces them with setWaits (seams_test.go), which gives back the restore.
type waitTimings struct {
	// pasteVerifyWait and pasteVerifyEvery: how long, and how often, the gate looks for pasted text in the input box before deciding
	// the paste didn't land.
	pasteVerifyWait  time.Duration
	pasteVerifyEvery time.Duration
	// pasteStuckAfter (pasteStuckAfterUrgent with a mention behind it): how long a held paste of Coral's that can't be confirmed waits
	// before it is given up.
	pasteStuckAfter       time.Duration
	pasteStuckAfterUrgent time.Duration
	// surveyGoneWait is how long after the 0 the screen is read for the survey to be gone, surveyPoll how often, and surveyRetryGap
	// how long before the 0 is sent again to a session whose survey did not go (a screen that does not change must not be sent digits
	// every pass).
	surveyGoneWait time.Duration
	surveyPoll     time.Duration
	surveyRetryGap time.Duration
	// promptSubmitDelay separates a bracketed paste from the submitting Enter.
	promptSubmitDelay time.Duration
	// rawKeyGap separates the keys of one /keys request.
	rawKeyGap time.Duration
	// launchWait, launchFallback and launchEvery: how long a RequireInputBox send waits in all (an open prompt or a blank screen), how long for an agent whose input
	// box Coral does not recognise, and how often it looks again.
	launchWait, launchFallback, launchEvery time.Duration
	// treeGrace is how long what a killed tmux agent started is given to end on the hangup and SIGTERM before it is killed (tmux_tree_unix.go). A test that proves the signals themselves ended it, not the SIGKILL
	// after the grace, lengthens it so that a stall of the machine cannot let the kill come first (#8025).
	treeGrace time.Duration
	// noticeHoldMax and noticeHoldStep: how long a notice for an agent that was just launched is held until its process is recorded, and how often it is checked again (NoticeBlockedWait).
	noticeHoldMax, noticeHoldStep time.Duration
}

var waitsP atomic.Pointer[waitTimings]

func init() {
	waitsP.Store(&waitTimings{
		pasteVerifyWait:       time.Second,
		pasteVerifyEvery:      100 * time.Millisecond,
		pasteStuckAfter:       time.Minute,
		pasteStuckAfterUrgent: 10 * time.Second,
		surveyGoneWait:        4 * time.Second,
		surveyPoll:            150 * time.Millisecond,
		surveyRetryGap:        30 * time.Second,
		promptSubmitDelay:     150 * time.Millisecond,
		rawKeyGap:             100 * time.Millisecond,
		launchWait:            15 * time.Minute,
		launchFallback:        2 * time.Minute,
		launchEvery:           time.Second,
		treeGrace:             3 * time.Second,
		noticeHoldMax:         15 * time.Second,
		noticeHoldStep:        200 * time.Millisecond,
	})
}

// waits is the timings in force; read it once per use and keep the value, so one pass sees one set.
func waits() *waitTimings { return waitsP.Load() }
