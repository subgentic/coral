// Send now: the Operator's way to deliver what the gate holds for an agent at once (#7554). The gate holds an agent's automated input (board nudges and messages) while it judges the agent busy, asking or
// drafting; when that judgment is wrong, or the Operator knows better, the held message goes by hand.

package ptymanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"
)

// HeldMessage is one send held for a session as the Operator sees it: who sent it, since when and why it waits, never its text. ID names it for SendHeldNow.
type HeldMessage struct {
	ID     string
	What   string
	Since  time.Time
	Reason string // one of HeldReasons
}

// heldID names a held send by its session and key, the same after it is held again (a paste whose Enter was withheld is held again with the same key).
func heldID(name, key string) string {
	sum := sha256.Sum256([]byte(name + "\x00" + key))
	return hex.EncodeToString(sum[:6])
}

// HeldMessages lists what is held for name, oldest first (the send being tried now included, as HeldCount counts it).
func HeldMessages(name string) []HeldMessage {
	gate.mu.Lock()
	defer gate.mu.Unlock()
	var out []HeldMessage
	add := func(h *heldInput) {
		out = append(out, HeldMessage{ID: heldID(name, h.in.Key), What: h.in.What, Since: h.heldAt, Reason: heldReasonOf(h.why, h.kind)})
	}
	if h := gate.inflight[name]; h != nil {
		add(h)
	}
	for _, h := range gate.held[name] {
		add(h)
	}
	return out
}

// ErrSendNowBusy is SendHeldNow giving up: the agent's sends are busy (the retry loop is typing one) for longer than the caller waited.
var ErrSendNowBusy = errors.New("the agent's held messages are being delivered right now")

// SendNowResult says what SendHeldNow did.
type SendNowResult struct {
	Sent  int // typed now
	Again int // held again: a prompt opened before the Enter (or the team's next slot is not due); it stays in the queue
	Gone  int // no longer wanted, or the send failed: removed
	Left  int // still in the queue after this call (what is behind a send held again, or behind an open prompt, is not tried)
	// Prompt is why nothing more was typed when a real prompt or menu is open on the agent's screen ("" otherwise): text put into it could answer it, so that stays the gate's rule even here.
	Prompt string
	// Draft: nothing more was typed because the agent's input box holds text that is not Coral's (a person's draft), which is never added to.
	Draft bool
}

// SendHeldNow types the sends held for name now, without asking whether the agent is waiting: the one with the given id, or every one when id is "". The Operator chose it, knowing the agent may be in the middle of a turn.
// A send is taken off the queue under the session's lock before it is typed, the lock the retry loop also holds while it types, so a send goes once however the call races the normal release or another call. What
// is not found (already delivered, already dropped, no such id) counts for nothing. A prompt or menu that is really open on the agent's screen still holds everything (Prompt says why, nothing is typed), and a prompt
// that opens between a send's text and its Enter still withholds the Enter, as for every send.
func SendHeldNow(ctx context.Context, name, id string) (SendNowResult, error) {
	g := gate
	unlock, ok := g.lockSessionCtx(ctx, name)
	if !ok {
		return SendNowResult{}, ErrSendNowBusy
	}
	defer unlock()
	g.mu.Lock()
	var taken, kept []*heldInput
	for _, h := range g.held[name] {
		if id == "" || heldID(name, h.in.Key) == id {
			taken = append(taken, h)
		} else {
			kept = append(kept, h)
		}
	}
	if len(taken) > 0 {
		if len(kept) == 0 {
			delete(g.held, name)
		} else {
			g.held[name] = kept
		}
	}
	g.mu.Unlock()

	var res SendNowResult
	for i, h := range taken {
		if why := openPromptOn(ctx, h.in); why != "" {
			// Not typed, and not lost: it and what follows it go back to the front, in order.
			g.mu.Lock()
			g.held[name] = append(append([]*heldInput{}, taken[i:]...), g.held[name]...)
			g.mu.Unlock()
			res.Prompt = why
			res.Left = HeldCount(name)
			return res, nil
		}
		g.mu.Lock()
		if g.inflight == nil {
			g.inflight = map[string]*heldInput{}
		}
		g.inflight[name] = h
		outcome, why := g.typeHeld(ctx, name, h, true) // releases g.mu
		switch outcome {
		case heldSent:
			res.Sent++
		case heldGone:
			res.Gone++
		case heldAgain, heldRefused:
			if outcome == heldRefused {
				if why == ForceRefusedDraft {
					res.Draft = true
				} else {
					res.Prompt = "a prompt opened"
				}
			} else {
				res.Again++
			}
			if rest := taken[i+1:]; len(rest) > 0 {
				// Order is kept: what was not tried goes back right behind the one held again.
				g.mu.Lock()
				q := g.held[name]
				at := min(1, len(q))
				g.held[name] = append(append(append([]*heldInput{}, q[:at]...), rest...), q[at:]...)
				g.mu.Unlock()
			}
			g.checkEnded(name)
			res.Left = HeldCount(name)
			return res, nil
		}
	}
	g.checkEnded(name)
	res.Left = HeldCount(name)
	return res, nil
}

// openPromptOn is why a prompt or menu is open on the screen of in's agent (a request, a selection, a dialog), or "" when none is or the screen cannot be read.
func openPromptOn(ctx context.Context, in AutomatedInput) string {
	r, ok := in.Term.(ScreenReader)
	if !ok {
		return ""
	}
	agentType, sessionID := in.identity()
	screen, err := r.AgentScreen(ctx, in.Name, agentType, sessionID)
	if err != nil {
		return ""
	}
	if open, why := PromptOnScreen(screen); open && isPromptHold(why) {
		return why
	}
	return ""
}
