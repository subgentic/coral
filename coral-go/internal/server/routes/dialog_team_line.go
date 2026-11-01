package routes

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/teamhealth"
)

// The team line (goal #14, part (b) of the Lead's #6536): a dialog that waits for a person holds the agent's task, and the team is told which, so work on other goals goes on and the orchestrator
// can reassign it. From the dialog watch (at_dialog), so any dialog counts, not only one that held a delivery. Posted to the agent's team once per episode (the agent and when its dialog was first
// seen): when it has waited the team's held_notice minutes (with held_notice on), and again when the dialog timeout closed it. No screen text, as the held notice (Security's #4176 rule 10): the
// agent's cleaned name, its task and goal numbers, and the minutes; nothing the agent or anyone wrote.

const (
	dialogLineWaiting = "dialog-line-waiting"
	dialogLineClosed  = "dialog-line-closed"
	dialogLineSender  = "Coral Task Queue"
)

// dialogWork is what waits with the agent: its task in progress on the board and that task's goal (0 when there is none).
type dialogWork struct {
	name         string
	task, goal   int64
	subscriberID string
}

// dialogWorkOf is the agent's subscription on its team and its task and goal there, or false when it is not on the team.
func (h *SessionsHandler) dialogWorkOf(ctx context.Context, a liveAgent) (dialogWork, bool) {
	if h.bs == nil || a.board == "" {
		return dialogWork{}, false
	}
	sub, err := h.bs.SessionSubscription(ctx, a.board, naming.SessionName(a.agentType, a.sid))
	if err != nil || sub == nil {
		return dialogWork{}, false
	}
	w := dialogWork{name: teamhealth.Name(sub.SubscriberID), subscriberID: sub.SubscriberID}
	if t := h.bs.ActiveTaskForSubscriber(ctx, a.board, sub.SubscriberID); t != nil {
		w.task = t.ID
		if t.GoalID != nil {
			w.goal = *t.GoalID
		}
	}
	return w, true
}

// waitsFor is the line's account of what waits: "task #T on goal #G", "task #T", or nothing in progress.
func (w dialogWork) waitsFor() string {
	switch {
	case w.task > 0 && w.goal > 0:
		return fmt.Sprintf("task #%d on goal #%d", w.task, w.goal)
	case w.task > 0:
		return fmt.Sprintf("task #%d", w.task)
	}
	return "no task in progress"
}

// dialogWaitingLine is the line for an agent whose dialog has waited minutes.
func dialogWaitingLine(w dialogWork, minutes int) string {
	line := fmt.Sprintf("[Coral health] %s is waiting at a dialog (%d min): %s waits for a person at their terminal. Work on other goals goes on.", w.name, minutes, w.waitsFor())
	if w.task > 0 {
		line += fmt.Sprintf(" To change who does #%d, the orchestrator reassigns it.", w.task)
	}
	return line
}

// dialogClosedLine is the line for a dialog the timeout closed: how, after how long, and whether the agent was told. An agent that was not told (the notice was not typed, or its input box
// did not come back) is named so: it does not know to post its question, so someone must tell it or answer at its terminal (Security's (b) on #420). Coral never types the notice again
// later outside the gate.
func dialogClosedLine(w dialogWork, minutes int, how, outcome string) string {
	told := "The agent was told to ask the Operator on the board."
	if outcome != timeoutDone {
		told = fmt.Sprintf("The agent was NOT told (%s): it does not know to post its question. Tell it on the board, or look at its terminal.", outcome)
	}
	return fmt.Sprintf("[Coral health] Coral closed %s's dialog after %d min (%s); %s goes on. %s", w.name, minutes, how, w.waitsFor(), told)
}

// postDialogClosedLine posts the closed line, for a close that was sent only: a close that failed left the dialog, and the waiting line already told the team.
func (h *SessionsHandler) postDialogClosedLine(ctx context.Context, a liveAgent, first, now time.Time, how, outcome string) {
	if !closeSent(outcome) {
		return
	}
	h.postDialogLine(ctx, a, dialogLineClosed, first, now, func(w dialogWork) string { return dialogClosedLine(w, int(now.Sub(first)/time.Minute), how, outcome) })
}

// postDialogLine posts line to the agent's team once for the episode (rule, the agent and first).
func (h *SessionsHandler) postDialogLine(ctx context.Context, a liveAgent, rule string, first, now time.Time, line func(dialogWork) string) {
	w, ok := h.dialogWorkOf(ctx, a)
	if !ok {
		return
	}
	episode := a.sid + "@" + first.UTC().Format(time.RFC3339Nano)
	if done, err := h.bs.HealthActionTaken(ctx, a.board, rule, episode); err != nil || done {
		return
	}
	if err := h.bs.RecordHealthAction(ctx, a.board, rule, episode, now); err != nil {
		return
	}
	if _, err := h.bs.PostSystemMessage(ctx, a.board, dialogLineSender, line(w), nil); err != nil {
		slog.Warn("dialog team line not posted", "board", a.board, "error", err)
	}
}

// dialogWaitingTeamLine posts the waiting line once the agent's dialog has waited the team's held_notice minutes.
func (h *SessionsHandler) dialogWaitingTeamLine(ctx context.Context, a liveAgent, hs board.HealthSettings, now time.Time) {
	if !hs.HeldNotice.On {
		return
	}
	_, first, due := h.dialogs.dialogDue(a.sid, time.Duration(hs.HeldNotice.AfterMin)*time.Minute, now)
	if !due {
		return
	}
	h.postDialogLine(ctx, a, dialogLineWaiting, first, now, func(w dialogWork) string { return dialogWaitingLine(w, int(now.Sub(first)/time.Minute)) })
}
