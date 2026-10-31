package routes

import (
	"context"
	"sort"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/ptr"
)

// An agent at a dialog (#11437, the server half of #11430): an agent can sit for hours on a screen that waits for the person (a folder-trust question, a login choice, a permission menu that its hooks
// never reported) and read as Idle, because "a prompt is open" was known only while a board message was unread. This watches the awake agents' screens through the prompt parser the answer route already
// uses and keeps, per agent, when the same prompt was first seen; the live row serves it as at_dialog {since, after_min, notify} and the dashboard turns it into "At a dialog" and, after after_min, a
// Needs you item.
//
// Cost: one screen read per awake agent per pass (dialogEvery), at most dialogMaxPerPass a pass, rotating so none starves; the list reads only the map, never the screen. A prompt counts only once
// the SAME one was on the screen in two passes in a row (a menu that is on screen for a moment while an agent works is not a dialog), and it is gone from the row the pass after its screen no longer shows
// it, or at once when an answer is sent (forgetDialog).

const (
	dialogEvery      = 15 * time.Second
	dialogMaxPerPass = 60
	dialogConfirmAt  = 2 // passes in a row with the same prompt
)

type dialogSeen struct {
	screen   promptScreen
	first    time.Time
	passes   int
	afterMin int
	notify   bool
}

// dialogWatch is the table of prompts seen; its zero value is ready.
type dialogWatch struct {
	mu     sync.Mutex
	seen   map[string]*dialogSeen // by session id
	offset int                    // where the next pass starts in the list of agents
}

// atDialogMinutes is how long an agent may wait at a dialog before it is a Needs you item when its team has no say: the team's own setting for it is held_notice.after_min (board.HealthSettings), the one
// that already tells the Operator about an agent whose messages waited at a dialog.
const atDialogMinutes = 10

func (w *dialogWatch) observe(sid string, screen promptScreen, shown bool, now time.Time, afterMin int, notify bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !shown {
		delete(w.seen, sid)
		return
	}
	if w.seen == nil {
		w.seen = map[string]*dialogSeen{}
	}
	e := w.seen[sid]
	if e == nil || !samePrompt(e.screen, screen) {
		w.seen[sid] = &dialogSeen{screen: screen, first: now, passes: 1, afterMin: afterMin, notify: notify}
		return
	}
	e.passes++
	e.afterMin, e.notify = afterMin, notify
}

func (w *dialogWatch) forget(sid string) {
	w.mu.Lock()
	delete(w.seen, sid)
	w.mu.Unlock()
}

// keepOnly drops every entry whose session is not in live (an agent that slept, was archived or ended).
func (w *dialogWatch) keepOnly(live map[string]bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for sid := range w.seen {
		if !live[sid] {
			delete(w.seen, sid)
		}
	}
}

// field is the live row's at_dialog: nil unless the same prompt has been on the agent's screen for two passes. since is when it was first seen. It carries no text of the prompt.
func (w *dialogWatch) field(sid string) any {
	w.mu.Lock()
	defer w.mu.Unlock()
	e := w.seen[sid]
	if e == nil || e.passes < dialogConfirmAt {
		return nil
	}
	return map[string]any{"since": e.first.UTC().Format(time.RFC3339), "after_min": e.afterMin, "notify": e.notify}
}

// forgetDialog clears an agent's dialog at once (an answer was sent); the next pass sees the screen again.
func (h *SessionsHandler) forgetDialog(sessionID string) { h.dialogs.forget(sessionID) }

// RunDialogWatch runs a pass every dialogEvery until ctx ends.
func (h *SessionsHandler) RunDialogWatch(ctx context.Context) {
	if h.ss == nil || h.terminal == nil {
		return
	}
	t := time.NewTicker(dialogEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		h.dialogPass(ctx, time.Now())
	}
}

// dialogPass is one pass: read the screen of each awake agent (up to dialogMaxPerPass, rotating) and note whether a prompt is on it.
func (h *SessionsHandler) dialogPass(ctx context.Context, now time.Time) {
	lives, err := h.ss.GetAllLiveSessions(ctx)
	if err != nil {
		return
	}
	var awake []liveAgent
	live := map[string]bool{}
	for _, ls := range lives {
		if ls.IsSleeping == 1 || ls.IsArchived == 1 || ls.AgentType == at.Terminal || ls.AgentType == at.Opencode {
			continue // a terminal has no agent screen; opencode's questions are its permission cards
		}
		awake = append(awake, liveAgent{ls.SessionID, ls.AgentName, ls.AgentType, ptr.Value(ls.BoardName)})
		live[ls.SessionID] = true
	}
	h.dialogs.keepOnly(live)
	sort.Slice(awake, func(i, j int) bool { return awake[i].sid < awake[j].sid })
	if len(awake) == 0 {
		return
	}
	h.dialogs.mu.Lock()
	start := h.dialogs.offset % len(awake)
	h.dialogs.offset = start + dialogMaxPerPass
	h.dialogs.mu.Unlock()
	n := min(len(awake), dialogMaxPerPass)
	for i := 0; i < n; i++ {
		if ctx.Err() != nil {
			return
		}
		a := awake[(start+i)%len(awake)]
		screen, shown, err := h.readPromptScreen(ctx, a.name, a.agentType, a.sid)
		if err != nil { // a screen that cannot be read says nothing: not a dialog, and not a cleared one either
			continue
		}
		after, notify := h.dialogMinutes(ctx, a.board)
		h.dialogs.observe(a.sid, screen, shown, now, after, notify)
	}
}

// liveAgent is the part of a live session a pass needs.
type liveAgent struct{ sid, name, agentType, board string }

// dialogMinutes is the team's held_notice setting for the agent's board: how long, and whether it is on; an agent on no board gets the default.
func (h *SessionsHandler) dialogMinutes(ctx context.Context, project string) (int, bool) {
	if h.bs == nil || project == "" {
		return atDialogMinutes, true
	}
	s := h.bs.GetHealthSettings(ctx, project).HeldNotice
	return s.AfterMin, s.On
}
