package ptymanager

import (
	"sync"
	"sync/atomic"
	"time"
)

// A person's send to an agent (the dashboard's composer, Coral Hub at Interact, the signed CLI) and the text it may leave in the agent's input box are what Coral's own typing (a board nudge) and the turn-end
// hand-off keep away from that agent (#10996): either starts a turn, or types into the box, that the person's Enter is competing with. An agent flooded with board messages was never idle for a person's send
// (#10992). The routes package marks the send; DeliverAutomated and the hand-off ask.

// personTextHold is how long a message the person's send left in the box (its Enter not taken) keeps Coral away: a mark is cleared when that message is submitted or cleared, and lapses by itself so an agent
// whose box is never cleared is not cut off from the board for ever. An atomic so a test can shorten it without a data race.
var personTextHoldNs atomic.Int64

func init() { personTextHoldNs.Store(int64(60 * time.Second)) }

var personSends = struct {
	mu       sync.Mutex
	inFlight map[string]int
	boxUntil map[string]time.Time
}{inFlight: map[string]int{}, boxUntil: map[string]time.Time{}}

// BeginPersonSend marks a person's send in flight for the agent (its session id) and returns the function that ends it, once. Sends may queue for one agent: it counts them.
func BeginPersonSend(sessionID string) (end func()) {
	if sessionID == "" {
		return func() {}
	}
	personSends.mu.Lock()
	personSends.inFlight[sessionID]++
	personSends.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			personSends.mu.Lock()
			defer personSends.mu.Unlock()
			if personSends.inFlight[sessionID]--; personSends.inFlight[sessionID] <= 0 {
				delete(personSends.inFlight, sessionID)
			}
		})
	}
}

// NotePersonTextInBox marks (in true) that a person's message was typed and its Enter not seen to take, or clears the mark (it was submitted, or cleared).
func NotePersonTextInBox(sessionID string, in bool) {
	if sessionID == "" {
		return
	}
	personSends.mu.Lock()
	defer personSends.mu.Unlock()
	if in {
		personSends.boxUntil[sessionID] = time.Now().Add(time.Duration(personTextHoldNs.Load()))
	} else {
		delete(personSends.boxUntil, sessionID)
	}
}

// PersonSendActive reports whether a person's send is in flight for the agent, or its text may still sit in the agent's box. False for no session id.
func PersonSendActive(sessionID string) bool {
	if sessionID == "" {
		return false
	}
	personSends.mu.Lock()
	defer personSends.mu.Unlock()
	if personSends.inFlight[sessionID] > 0 {
		return true
	}
	until, ok := personSends.boxUntil[sessionID]
	if ok && time.Now().After(until) {
		delete(personSends.boxUntil, sessionID)
		return false
	}
	return ok
}
