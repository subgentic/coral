package routes

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// The dialog timeout (goal #14, the Lead's #6543 with Security's #6540): a dialog that waited for a person longer than the team's dialog_timeout.after_min is closed the safe way (the
// reject labelled exactly "No", or Esc: never an allow), and the agent is told, in fixed words, to ask the Operator on the board and go on with its other work. Off by default; only the
// Operator turns it on (the team's health settings, an operator-only route).
//
// It acts only when all of these hold, the last ones checked again inside the agent's lock (agent_lock.go) just before the key:
//   - the dialog watch has seen the same prompt (its AskID) for after_min, and Coral has not closed that prompt before (one close per agent and AskID, never retried);
//   - the agent is on a team board, awake, not archived, and its auto-accept is off;
//   - nobody is present: no one typed in its terminal, and no focused dashboard terminal view of it was reported, in the last dialogPresence;
//   - the CLI and the prompt's kind have a mapped close (dialogCloseFor): anything else is left alone;
//   - the notice gate would let the notice through once the dialog is gone (not paused or held by typing, no send of a person's in flight, the CLI in the foreground, no draft seen).
// Then, in order: close; wait for the CLI's ordinary input box (up to promptClearTimeout), then promptSettle; type the notice through the normal gate; release the lock.

// dialogTimeoutNotice is typed into the agent after a close. Fixed: no digit and nothing variable (Security's MUST 1), so no part of it can answer a menu or carry another's words.
const dialogTimeoutNotice = "[Coral] A question you asked waited longer than the limit the operator set and was closed without an answer. Coral did not choose for you. If you still need that decision, post the question and its options to the Operator as one coral-board message, then go on with your other work and leave that decision until the answer arrives. Do not retry the same action before the operator answers."

// dialogPresence is how recent a person's typing in the agent's terminal, or a focused dashboard view of it, keeps Coral's hands off.
const dialogPresence = 2 * time.Minute

// The ways a close is described in the agent event: the reject option was taken, or the dialog was cancelled with Esc.
const (
	dialogDeclined  = "declined"
	dialogCancelled = "cancelled"
)

// dialogClose is how one prompt is closed: the keys, and what they do.
type dialogClose struct {
	keys []string
	how  string
}

// dialogCloseFor is the close for a prompt of kind (the agent's WaitingKind) on agentType's screen s, or false: the prompt is left alone.
//   - Claude Code: a permission or a plan takes the reject option only when its label is exactly "No", else Esc; a question takes Esc.
//   - Codex: an approval and a question take Esc (its documented cancel).
//   - Any other CLI or kind, a menu without numbers (a launch or sign-in screen), a dialog with a heading of its own (Hooks need review) and a review step: nothing.
func dialogCloseFor(agentType, kind string, s promptScreen) (dialogClose, bool) {
	if s.Unnumbered || s.Title != "" || len(s.Review) > 0 || len(s.Options) == 0 {
		return dialogClose{}, false
	}
	esc := dialogClose{keys: []string{"Escape"}, how: dialogCancelled}
	switch agentType {
	case at.Claude:
		switch kind {
		case "permission", "plan":
			var no []promptOption
			for _, o := range s.Options {
				if normalizeLabel(o.Label) == "no" && optionIsReject(o) {
					no = append(no, o)
				}
			}
			if len(no) == 1 && no[0].N >= 1 && no[0].N <= 9 && !s.Multi {
				return dialogClose{keys: []string{strconv.Itoa(no[0].N)}, how: dialogDeclined}, true
			}
			return esc, true
		case "question":
			return esc, true
		}
	case at.Codex:
		switch kind {
		case "permission", "question":
			return esc, true
		}
	}
	return dialogClose{}, false
}

// dialogScreenExcluded says the screen's text is one Coral never closes, whatever parsed from it: a trust question (its No can exit the CLI) or an update offer at launch, a sign-in screen,
// Codex's hook review. (StartupPromptOnScreen's third answer, any other prompt, means something only before the agent's first event; the agent's WaitingKind decides those.)
func dialogScreenExcluded(text string) bool {
	if why := ptymanager.StartupPromptOnScreen(text); why == ptymanager.StartupTrust || why == ptymanager.StartupUpdate || ptymanager.CodexHooksReviewOnScreen(text) {
		return true
	}
	login, _ := ptymanager.ClaudeLoginOnScreen(text)
	return login
}

// terminalFocus is, per agent (session id) and per dashboard terminal VIEW of it (its socket), when that view last said it was focused; its zero value is ready. One view's report never
// touches another's: a second tab, a phone or a Hub mirror that is not focused does not clear the view a person is looking at (Security's SHOULD 1 on #420).
type terminalFocus struct {
	mu sync.Mutex
	m  map[string]map[string]time.Time // session id -> view -> last focused report
}

// note records a view's report: focused stamps it, not focused drops it.
func (f *terminalFocus) note(sid, view string, focused bool, now time.Time) {
	if sid == "" || view == "" {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !focused {
		f.dropLocked(sid, view)
		return
	}
	if f.m == nil {
		f.m = map[string]map[string]time.Time{}
	}
	if f.m[sid] == nil {
		f.m[sid] = map[string]time.Time{}
	}
	f.m[sid][view] = now
}

// closed drops a view whose socket closed.
func (f *terminalFocus) closed(sid, view string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dropLocked(sid, view)
}

func (f *terminalFocus) dropLocked(sid, view string) {
	if views := f.m[sid]; views != nil {
		delete(views, view)
		if len(views) == 0 {
			delete(f.m, sid)
		}
	}
}

// within says ANY view of the agent reported focus within d.
func (f *terminalFocus) within(sid string, d time.Duration, now time.Time) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, t := range f.m[sid] {
		if now.Sub(t) < d {
			return true
		}
	}
	return false
}

// keepOnly drops the views of agents that are no longer live.
func (f *terminalFocus) keepOnly(live map[string]bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for sid := range f.m {
		if !live[sid] {
			delete(f.m, sid)
		}
	}
}

// personPresent says a person is at the agent: typed in its terminal, or has its dashboard terminal focused, within dialogPresence.
func (h *SessionsHandler) personPresent(sid string, now time.Time) bool {
	return terminalinput.PersonTypedWithin(sid, dialogPresence) || h.focus.within(sid, dialogPresence, now)
}

// dialogEpisodes are the prompts Coral closed, by agent and AskID: each is closed once and never again. Its zero value is ready.
type dialogEpisodes struct {
	mu sync.Mutex
	m  map[string]time.Time
}

// dialogEpisodeKeep is how long a closed prompt is remembered: the same AskID long after is another episode of the same question.
const dialogEpisodeKeep = 24 * time.Hour

func episodeKey(sid, askID string) string { return sid + "\x00" + askID }

func (e *dialogEpisodes) closed(sid, askID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.m[episodeKey(sid, askID)]
	return ok
}

// take records the episode as closed; false when it was already.
func (e *dialogEpisodes) take(sid, askID string, now time.Time) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.m == nil {
		e.m = map[string]time.Time{}
	}
	for k, t := range e.m {
		if now.Sub(t) > dialogEpisodeKeep {
			delete(e.m, k)
		}
	}
	k := episodeKey(sid, askID)
	if _, ok := e.m[k]; ok {
		return false
	}
	e.m[k] = now
	return true
}

// dialogDue is the prompt the watch has seen on the agent's screen for at least after, or false.
func (w *dialogWatch) dialogDue(sid string, after time.Duration, now time.Time) (promptScreen, time.Time, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	e := w.seen[sid]
	if e == nil || e.passes < dialogConfirmAt || e.screen.AskID == "" || now.Sub(e.first) < after {
		return promptScreen{}, time.Time{}, false
	}
	return e.screen, e.first, true
}

// The outcomes of one try, for the agent event and the tests.
const (
	timeoutNotDue     = "not_due"
	timeoutPresent    = "person_present"
	timeoutBusy       = "busy"
	timeoutExcluded   = "excluded"
	timeoutGateHolds  = "gate_holds"
	timeoutUnsentText = "left_alone_unsent_text" // a person typed text that is not sent: a dialog opened over it may hide it (Security's #6815)
	timeoutChanged    = "changed"
	timeoutSendFailed = "send_failed"
	timeoutNoBox      = "closed_no_input_box"
	timeoutNotTyped   = "closed_notice_not_typed"
	timeoutDone       = "closed_notice_typed"
)

// dialogTimeout is one agent's try: it closes the prompt and types the notice when everything above holds, and says what happened. after is the team's after_min.
func (h *SessionsHandler) dialogTimeout(ctx context.Context, a liveAgent, after time.Duration, now time.Time) string {
	before, first, due := h.dialogs.dialogDue(a.sid, after, now)
	if !due || h.episodes.closed(a.sid, before.AskID) {
		return timeoutNotDue
	}
	if terminalinput.PersonDraftPending(a.sid) {
		return timeoutUnsentText // left alone: a close would go over a person's unsent text, and the notice could not follow
	}
	if h.personPresent(a.sid, now) {
		return timeoutPresent
	}
	if st, err := h.ss.GetAutoAcceptState(ctx, a.sid); err != nil || st.Enabled {
		return timeoutExcluded // auto-accept's own rules apply to an agent that has it on; a state that cannot be read is not off
	}
	kind := h.deriveSingleSessionState(ctx, a.sid, 0).WaitingKind
	if _, ok := dialogCloseFor(a.agentType, kind, before); !ok {
		return timeoutExcluded
	}
	pane := naming.SessionName(a.agentType, a.sid) // the terminal's own name: the screen, the keys and the gate all use it
	unlock, ok := h.tryLockAgent(a.sid)
	if !ok {
		return timeoutBusy // a person's answer or another close is under way: the next pass looks again
	}
	defer unlock()
	if h.noticeWouldHold(ctx, pane, a) {
		return timeoutGateHolds // the notice could not follow the close: nothing is closed (the team line says so)
	}
	// Inside the lock: the screen again, the same prompt, the same kind, the same close.
	screen, shown, text, err := h.readPromptScreenText(ctx, pane, a.agentType, a.sid)
	if err != nil || !shown || screen.AskID != before.AskID || dialogScreenExcluded(text) || h.personPresent(a.sid, now) {
		return timeoutChanged
	}
	kind = h.deriveSingleSessionState(ctx, a.sid, 0).WaitingKind
	plan, ok := dialogCloseFor(a.agentType, kind, screen)
	if !ok {
		return timeoutExcluded
	}
	if !h.episodes.take(a.sid, screen.AskID, now) {
		return timeoutNotDue
	}
	ptymanager.NoteDialogClose(pane)
	if err := h.terminal.SendRawInput(ctx, terminalinput.Internal, pane, plan.keys, a.agentType, a.sid); err != nil {
		slog.Warn("dialog timeout: the close was not sent", "session", a.sid, "error", err)
		h.recordDialogClosed(ctx, a, first, now, plan.how, timeoutSendFailed)
		return timeoutSendFailed
	}
	h.hints.forget(a.sid)
	h.forgetDialog(a.sid)
	outcome := timeoutNoBox
	if h.waitInputBox(ctx, pane, a, screen) {
		time.Sleep(promptSettle)
		delivery, err := deliverNoticeRetrying(ctx, h.terminal, pane, a.agentType, a.sid, dialogTimeoutNotice, "dialog timeout notice")
		outcome = timeoutNotTyped
		if err == nil && delivery == ptymanager.Sent {
			outcome = timeoutDone
		}
	}
	h.recordDialogClosed(ctx, a, first, now, plan.how, outcome)
	return outcome
}

// noticeWouldHold says the gate would hold the notice for a reason other than the dialog itself: the person paused notices or is typing, has unsent text in the terminal (a draft a dialog may hide), a send of theirs is in flight, the CLI is not in
// the foreground (an exited CLI, a nested shell), or a draft held the last automated send.
func (h *SessionsHandler) noticeWouldHold(ctx context.Context, pane string, a liveAgent) bool {
	if ptymanager.NoticesHeld(a.sid) || ptymanager.PersonSendActive(a.sid) || terminalinput.PersonDraftPending(a.sid) {
		return true
	}
	if _, draft := ptymanager.SkippedAtDraft()[pane]; draft {
		return true
	}
	return automatedInputBlocked(ctx, h.terminal, pane, a.agentType, a.sid, "dialog timeout")
}

// waitInputBox waits, up to promptClearTimeout, for the prompt to be gone and the CLI's ordinary input box on the screen.
func (h *SessionsHandler) waitInputBox(ctx context.Context, pane string, a liveAgent, before promptScreen) bool {
	deadline := time.Now().Add(promptClearTimeout)
	for {
		now, ok, text, err := h.readPromptScreenText(ctx, pane, a.agentType, a.sid)
		if err == nil && !(ok && samePrompt(before, now)) && !menuStillDrawn(text, before) && ptymanager.InputBoxOnScreen(text) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(promptPollEvery):
		}
	}
}

// dialogRecordTimeout bounds the writes that record a close (the agent event, and the team line).
const dialogRecordTimeout = 10 * time.Second

// closeSent says the close went (outcome closed_*): only then is the dialog gone.
func closeSent(outcome string) bool {
	return outcome == timeoutDone || outcome == timeoutNotTyped || outcome == timeoutNoBox
}

// recordDialogClosed writes the agent event of a try that sent or failed to send a close. Only a close that was sent resolves the agent's request (as the Operator's dismissal does); one that
// failed (send_failed, opencode's reject not taken) is recorded as an event of its own and the wait stays open (Security's SHOULD 2 on #420).
func (h *SessionsHandler) recordDialogClosed(ctx context.Context, a liveAgent, first, now time.Time, how, outcome string) {
	if h.ts == nil {
		return
	}
	// A context of its own: the close already happened, so its record is written even when the pass's context ended meanwhile (a stop, a slow delivery).
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), dialogRecordTimeout)
	defer cancel()
	sid := a.sid
	sent := closeSent(outcome)
	fields := map[string]any{"minutes": int(now.Sub(first) / time.Minute), "how": how, "outcome": outcome, "closed_by": "dialog_timeout"}
	eventType, summary := "dialog_close_failed", "Coral could not close a dialog that waited past the team's limit"
	if sent {
		fields["dismissed"] = true
		eventType, summary = "request_resolved", "Coral closed a dialog that waited past the team's limit"
	}
	detail, _ := json.Marshal(fields)
	dj := string(detail)
	ev := &store.AgentEvent{AgentName: a.name, SessionID: &sid, EventType: eventType, Summary: summary, DetailJSON: &dj}
	if _, err := h.ts.InsertAgentEvent(ctx, ev); err != nil {
		slog.Warn("dialog timeout: recording the close failed", "session", sid, "error", err)
		return
	}
	if sent {
		h.pending.markRequest(sid, false)
		h.kickFeedForRequestChange(sid, "request_resolved")
	}
}
