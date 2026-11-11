package routes

import (
	"context"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/terminalinput"
)

// A live switch can make Claude Code ask a follow-up in its terminal that no transcript entry or hook records: "/model <name>" on a conversation that has a cache opens "Switch model? ... 1. Yes, switch to X / 2. No, go back" (#5488).
// The switch used to wait for a transcript entry that the dialog was holding back, end 30 s later with "did not confirm" and leave the dialog open (#15410). Now every wait looks at the screen: the one question the switch itself implies
// (Yes to the switch it was asked for) is answered by Coral, once; any other is put on the switch (asking) and on the chat as a card, the wait does not run out while it is open, and the switch goes on when a person answers.

// switchAsker watches one switch's terminal for a dialog. A nil asker sees none.
type switchAsker struct {
	h         *SessionsHandler
	seq       int64
	name      string
	agentType string
	sessionID string
	model     string
	setModel  bool
	answered  bool // the implied Yes was sent: never sent twice
}

// open reports whether a dialog is open on the agent's screen now, answering the one the switch implies and noting any other.
func (a *switchAsker) open(ctx context.Context) bool {
	if a == nil || a.h.terminal == nil {
		return false
	}
	ps, ok := a.h.capturePromptScreen(ctx, a.name, a.agentType, a.sessionID)
	if !ok || len(ps.Options) == 0 {
		a.h.modelSwitches.update(a.sessionID, a.seq, func(s *modelSwitch) { s.Asking = "" })
		return false
	}
	if n := a.impliedYes(ps); n > 0 {
		if a.answered {
			return true // sent: the dialog is closing, not a question for the person
		}
		a.answered = true
		if a.answer(ctx, ps, n) {
			return true
		}
	}
	question := askingText(ps.Title, ps.Question)
	a.h.modelSwitches.update(a.sessionID, a.seq, func(s *modelSwitch) { s.Asking = question })
	a.h.hints.noteSlash(a.sessionID) // the chat reads the screen for the card while it is open
	a.h.kickWS()
	return true
}

// askingText is the dialog's title and question as one line for the chat: terminal control codes and invisible characters out (the screen is another program's text), cut to 240 bytes on a character boundary so a
// multi-byte character is never split into invalid UTF-8 (#15451).
func askingText(title, question string) string {
	text := clitext.CleanName(title + " " + question)
	if len(text) <= 240 {
		return text
	}
	cut := 240
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "…"
}

// impliedYes is the number of the option that says Yes to the cache dialog of "/model <name>" when the dialog is that one and the switch asked for a model; 0 for any other dialog. The person chose this model; the dialog only warns that the next
// reply re-reads the history. The card's question is the dialog's last paragraph (its heading is not part of it), so the dialog is known by its two options: "Yes, switch to <model>" and "No, go back".
func (a *switchAsker) impliedYes(ps promptScreen) int {
	if !a.setModel || len(ps.Options) != 2 {
		return 0
	}
	yes, no := strings.ToLower(strings.TrimSpace(ps.Options[0].Label)), strings.ToLower(strings.TrimSpace(ps.Options[1].Label))
	if strings.HasPrefix(yes, "yes, switch") && strings.HasPrefix(no, "no") {
		return 1
	}
	return 0
}

// answer sends the digit for option n if the screen still shows the same dialog (under the agent's lock, as a person's answer is).
func (a *switchAsker) answer(ctx context.Context, ps promptScreen, n int) bool {
	defer a.h.lockAgent(a.sessionID)()
	now, ok := a.h.capturePromptScreen(ctx, a.name, a.agentType, a.sessionID)
	if !ok || !samePrompt(ps, now) {
		return false
	}
	if err := a.h.terminal.SendRawInput(ctx, terminalinput.Unclassified, a.name, []string{strconv.Itoa(n)}, a.agentType, a.sessionID); err != nil {
		return false
	}
	a.h.hints.forget(a.sessionID)
	a.h.startupScreens.forget(promptReadKey(a.sessionID, a.name, a.agentType))
	return true
}
