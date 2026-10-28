package routes

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// A person's chat message is typed into the agent's box at once, but the agent's CLI writes it to its transcript a moment later, and for an agent busy with a turn, much later. The screen that sent it
// shows it as a pending bubble meanwhile; a second screen showing the same agent had nothing to show until the transcript had it, so it missed the message (#10467, Mobile pass 22). The live
// row therefore lists the messages typed in the last pendingSendsFor (pending_sends: [{id, text, at}]); a screen draws the ones it did not send as pending, and settles them as it does its own,
// when the transcript has them. The list is bounded and short-lived: it is not the record of a chat. The text is the person's own, as held_messages' is, and goes through the connector's
// redaction on a Hub path the same way.
const (
	pendingSendsFor   = 90 * time.Second
	pendingSendsMax   = 5    // per agent
	pendingSendsRunes = 1000 // a message's words in the row; the transcript has the rest
)

type pendingSend struct {
	id   string
	text string
	at   time.Time
}

// pendingSends is the recent person-typed messages per agent (session id). Its zero value is ready.
type pendingSends struct {
	mu sync.Mutex
	m  map[string][]pendingSend
}

// note records a message typed into the agent now, and drops what has outlived the list for every agent.
func (p *pendingSends) note(sessionID, text string) {
	if sessionID == "" || text == "" {
		return
	}
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return
	}
	now := time.Now()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.m == nil {
		p.m = map[string][]pendingSend{}
	}
	for id, list := range p.m {
		keep := list[:0]
		for _, s := range list {
			if now.Sub(s.at) <= pendingSendsFor {
				keep = append(keep, s)
			}
		}
		if len(keep) == 0 {
			delete(p.m, id)
		} else {
			p.m[id] = keep
		}
	}
	list := append(p.m[sessionID], pendingSend{id: hex.EncodeToString(b), text: text, at: now})
	if len(list) > pendingSendsMax {
		list = list[len(list)-pendingSendsMax:]
	}
	p.m[sessionID] = list
}

// pendingSendsOf is the live row's pending_sends: the agent's messages typed in the last pendingSendsFor, oldest first, or nil (a null) when there are none.
func (h *SessionsHandler) pendingSendsOf(sessionID string) any {
	p := &h.sends
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []map[string]any
	for _, s := range p.m[sessionID] {
		if time.Since(s.at) > pendingSendsFor {
			continue
		}
		text := []rune(s.text)
		if len(text) > pendingSendsRunes {
			text = text[:pendingSendsRunes]
		}
		out = append(out, map[string]any{"id": s.id, "text": string(text), "at": s.at.UTC().Format(time.RFC3339Nano)})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
