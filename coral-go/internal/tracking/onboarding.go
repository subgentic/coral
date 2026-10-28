package tracking

import (
	"strconv"
	"time"

	"github.com/google/uuid"
)

// The new-user funnel (#10004). Each event is a one-time milestone of the install, sent only while analytics are on, and carries a closed vocabulary or a bounded integer: never a prompt,
// a reply, a path or a name. They are emitted by the server, never accepted from the browser endpoint.

// TrackEULAAccepted records, once, that the Terms were accepted and how. It is called only once the acceptance is on disk and the saved analytics choice has been applied: nothing is sent for an install
// that has not accepted. An acceptance that was reached while analytics were off (it was recorded as reached, never sent, and nothing is waiting to be retried) is never sent later: turning analytics on
// afterwards does not announce an acceptance that happened while they were off.
func TrackEULAAccepted(source string) {
	if milestoneLostToOptOut(EventEULAAccepted) {
		return
	}
	TrackOnce(EventEULAAccepted, map[string]string{"source": source})
}

// milestoneLostToOptOut reports whether name was reached before and was neither sent nor left waiting for a retry: analytics were off when it happened.
func milestoneLostToOptOut(name string) bool {
	if !stateDirReady() {
		return false
	}
	milestoneMu.Lock()
	defer milestoneMu.Unlock()
	s := loadMilestones()
	_, reached := s.Reached[name]
	_, fired := s.Fired[name]
	_, pending := s.Pending[name]
	return reached && !fired && !pending
}

// IsFirstRun reports whether this data folder has not yet had a tracked open (the install event comes after the server starts), so an acceptance the marker records is this install's own and not an old
// install's from before the funnel had the event.
func IsFirstRun() bool {
	if !stateDirReady() {
		return false
	}
	milestoneMu.Lock()
	defer milestoneMu.Unlock()
	return loadMilestones().FirstOpenAt == ""
}

// TrackDashboardSignedIn records, once, the first dashboard sign-in and which kind of credential it used.
func TrackDashboardSignedIn(via string) {
	TrackOnce(EventDashboardSignedIn, map[string]string{"via": via})
}

// TrackFirstMessageSent records, once, the first message a person sent to an agent and the way it went.
func TrackFirstMessageSent(via string) {
	TrackOnce(EventFirstMessageSent, map[string]string{"via": via})
}

// firstReplyKey is the milestone key of one outcome: the first ok turn and the first error turn each send once, so a first turn that failed does not use up the install's reply event.
func firstReplyKey(outcome string) string { return EventFirstAgentReply + "|" + outcome }

// FirstReplyWanted reports whether a first_agent_reply could still be sent for an ok end: analytics are on and none was delivered yet. The server asks before it spends anything on tracking
// a person's message, so an install that has sent its reply event (or has analytics off) costs nothing.
func FirstReplyWanted() bool {
	if !posthogKeyPresent() || !telemetryEnabled() || !stateDirReady() {
		return false
	}
	milestoneMu.Lock()
	defer milestoneMu.Unlock()
	_, fired := loadMilestones().Fired[firstReplyKey(ReplyOK)]
	return !fired
}

// TrackFirstAgentReply records an agent turn that ended after a person's message: provider (the closed provider set), the whole seconds from the message to the end of the turn (0 to 3600; a
// longer wait is not measured and sends nothing) and whether the turn ended ok or in an error. Once per outcome.
func TrackFirstAgentReply(provider string, took time.Duration, outcome string) {
	if outcome != ReplyError {
		outcome = ReplyOK
	}
	secs := int(took / time.Second)
	if took < 0 || secs > replySeconds {
		return
	}
	if provider != "claude" && provider != "codex" && provider != "gemini" {
		provider = "other"
	}
	props := map[string]string{"provider": provider, "seconds_to_reply": strconv.Itoa(secs), "outcome": outcome}
	gen := telemetryGen.Load()
	asyncGo(func() {
		key := firstReplyKey(outcome)
		send, snap := reserveMilestone(key, posthogKeyPresent() && telemetryValid(gen), props)
		if !send {
			return
		}
		// The frozen snapshot is what is sent (and replayed on a retry), under a uuid that is stable for the install, the outcome and the snapshot.
		uid := uuid.NewSHA1(uuid.NameSpaceOID, []byte("coral-first-reply|"+getInstallID()+"|"+outcome+"|"+snap.Timestamp)).String()
		if emitEvent(EventFirstAgentReply, snap.Props, uid, snap.Timestamp, gen) {
			confirmMilestoneSent(key)
			return
		}
		releaseMilestone(key)
	})
}
