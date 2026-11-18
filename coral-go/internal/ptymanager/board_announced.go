package ptymanager

import "sync"

// The board messages a typed nudge has already announced to a session, by its name (#19622, "announce each board message once"): the newest message id the nudge covered. The turn-end hand-off reads it so a routine message that the
// nudge told the agent about is not announced again by a Stop-hook block. A message that mentions the agent, or is the Operator's, is still handed over at once.
var announcedBoard sync.Map // session name -> int64

// NoteBoardAnnounced records that a board nudge covering messages up to latestID was typed for the session.
func NoteBoardAnnounced(sessionName string, latestID int64) {
	if sessionName == "" || latestID <= 0 {
		return
	}
	if cur, ok := announcedBoard.Load(sessionName); ok && cur.(int64) >= latestID {
		return
	}
	announcedBoard.Store(sessionName, latestID)
}

// BoardAnnouncedUpTo is the newest message id a nudge has announced to the session (0: none).
func BoardAnnouncedUpTo(sessionName string) int64 {
	if v, ok := announcedBoard.Load(sessionName); ok {
		return v.(int64)
	}
	return 0
}

// forgetBoardAnnounced is called from forgetSession: a restarted, resumed, slept or woken agent, or a /clear, is a conversation that never saw those nudges (#19640).
func forgetBoardAnnounced(name string) { announcedBoard.Delete(name) }
