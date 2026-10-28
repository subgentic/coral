package routes

import (
	"context"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/tracking"
)

// The new-user funnel's two server-side steps (#10004): a person's first message to an agent (first_message_sent), and the first agent turn that ends after it (first_agent_reply). Both are
// worked out from what the server already knows (a person's send, a hook's prompt_submit and stop events): neither reads a prompt or a reply, and the only things kept are a session id, a time
// and an event id, in memory, a bounded number of them, until the turn ends.

// The funnel's tracking calls, as variables so the tests can watch them without a PostHog.
var (
	funnelFirstMessage = tracking.TrackFirstMessageSent
	funnelFirstReply   = tracking.TrackFirstAgentReply
	funnelReplyWanted  = tracking.FirstReplyWanted
)

// personMarkWindow is how long after a person's Enter in the terminal view a prompt_submit still counts as that person's typing.
const personMarkWindow = 10 * time.Second

// maxPersonMarks bounds both maps: past it a new mark is not kept (an install that has that many sessions waiting on a first reply has sent its funnel long ago).
const maxPersonMarks = 256

type personMark struct {
	at   time.Time // when the person's message was sent
	base int64     // the session's newest event id at that moment: a stop with a greater id is the turn that message started
}

// personMarks remembers, per session, a person's message whose turn has not ended yet, and the last Enter a person typed in a session's terminal view.
type personMarks struct {
	mu     sync.Mutex
	marks  map[string]personMark
	enters map[string]time.Time
}

func (p *personMarks) set(sessionID string, m personMark) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.marks == nil {
		p.marks = map[string]personMark{}
	}
	if _, ok := p.marks[sessionID]; !ok && len(p.marks) >= maxPersonMarks {
		return
	}
	if old, ok := p.marks[sessionID]; ok && old.at.Before(m.at) {
		return // the first message of the turn is the one measured from
	}
	p.marks[sessionID] = m
}

// take returns the mark of sessionID when eventID (a stop) is later than the event the message was sent after, and forgets it. A stop that is not later (an older turn's) leaves it.
func (p *personMarks) take(sessionID string, eventID int64) (personMark, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	m, ok := p.marks[sessionID]
	if !ok || eventID <= m.base {
		return personMark{}, false
	}
	delete(p.marks, sessionID)
	return m, true
}

func (p *personMarks) clear(sessionID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.marks, sessionID)
	delete(p.enters, sessionID)
}

// noteEnter records that a person pressed Enter in sessionID's terminal view (a time, never what was typed).
func (p *personMarks) noteEnter(sessionID string, now time.Time) {
	if sessionID == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.enters == nil {
		p.enters = map[string]time.Time{}
	}
	if _, ok := p.enters[sessionID]; !ok && len(p.enters) >= maxPersonMarks {
		return
	}
	p.enters[sessionID] = now
}

// takeEnter reports whether a person pressed Enter in the session's terminal view within personMarkWindow before now, and uses it up.
func (p *personMarks) takeEnter(sessionID string, now time.Time) (time.Time, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	at, ok := p.enters[sessionID]
	if !ok {
		return time.Time{}, false
	}
	delete(p.enters, sessionID)
	if now.Sub(at) > personMarkWindow || now.Before(at) {
		return time.Time{}, false
	}
	return at, true
}

// notePersonMessage is called when a person's message reached an agent: it counts the first message of the install and, while the install has not yet had a reply to count, marks the session so its
// next turn end is measured from sentAt. via is one of the tracking.MessageVia* values.
func (h *SessionsHandler) notePersonMessage(ctx context.Context, sessionID, via string, sentAt time.Time) {
	funnelFirstMessage(via)
	if sessionID == "" || !funnelReplyWanted() {
		return
	}
	base, _ := h.latestEvent(ctx, sessionID)
	h.person.set(sessionID, personMark{at: sentAt, base: base})
}

// notePersonTerminalPrompt is called for an agent's own prompt_submit: when a person pressed Enter in that session's terminal view just before it, the prompt was theirs, typed there.
func (h *SessionsHandler) notePersonTerminalPrompt(ctx context.Context, sessionID string, eventID int64) {
	if sessionID == "" {
		return
	}
	at, ok := h.person.takeEnter(sessionID, time.Now())
	if !ok {
		return
	}
	funnelFirstMessage(tracking.MessageViaTerminal)
	if funnelReplyWanted() {
		h.person.set(sessionID, personMark{at: at, base: eventID - 1}) // this prompt_submit is the turn's first event
	}
}

// noteAgentStop is called for an agent's own stop event (eventID is its stored id): when a person's message is waiting on this session and the stop is a later event than it, that turn is the first
// reply. failed is the StopFailure hook's "the turn ended in an error".
func (h *SessionsHandler) noteAgentStop(sessionID, agentType string, eventID int64, failed bool) {
	m, ok := h.person.take(sessionID, eventID)
	if !ok {
		return
	}
	outcome := tracking.ReplyOK
	if failed {
		outcome = tracking.ReplyError
	}
	funnelFirstReply(tracking.ProviderFor(agentType), time.Since(m.at), outcome)
}

// noteFunnelEvent is called for every event an agent's own hooks post (token-verified, so the session is the agent's): a prompt_submit a person typed in the terminal view, the stop that ends a
// turn (the first reply), and the reset or end that makes a waiting mark stale. created is the stored event.
func (h *SessionsHandler) noteFunnelEvent(ctx context.Context, sessionID, agentType, eventType string, detail any, created *store.AgentEvent) {
	if sessionID == "" || created == nil {
		return
	}
	switch eventType {
	case "prompt_submit":
		h.notePersonTerminalPrompt(ctx, sessionID, created.ID)
	case "stop":
		failed := false
		if d, ok := detail.(map[string]any); ok {
			failed, _ = d["failed"].(bool)
		}
		h.noteAgentStop(sessionID, agentType, created.ID, failed)
	case "session_reset", "session_end":
		h.person.clear(sessionID)
	}
}
