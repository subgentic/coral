// Delivering an automated input: one look at the screen, then the text and its Enter at once, or nothing (#7727).

package ptymanager

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/inputlog"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/terminalinput"
	"github.com/subgentic/coral/internal/tmux"
)

// ErrNotWanted is returned by a send's Ready or Send when what it was about is over by the time it would be typed (a board nudge whose
// messages the agent has read since, #4362): nothing is typed, and it is dropped quietly instead of reported as a failed send.
var ErrNotWanted = errors.New("automated input no longer wanted")

// The reasons a send is skipped (SkippedSend.Why): what the person sees on the agent's page.
const (
	SkipPrompt     = "a prompt is open"
	SkipDraft      = "you have a draft in the box"
	SkipUnreadable = "the screen could not be read"
	SkipEnter      = "a prompt opened before the Enter"
	SkipTeamBusy   = "this team's sends are spaced out and the next slot is too far away"
)

// DeliverAutomated types an automated send now, with its Enter, unless the screen shows that typing would be a wrong answer
// (see the package comment): then it types nothing, keeps nothing and says so (SkippedOf).
func DeliverAutomated(ctx context.Context, in AutomatedInput) (Delivery, error) {
	if in.Send == nil {
		return Sent, errors.New("automated input without a send function")
	}
	unlock := gate.lockSession(in.Name)
	defer unlock()
	if !in.force && PersonSendActive(in.SessionID) {
		// A person's send to this agent is in flight, or its text may still be in the box: Coral's text would start a turn or join theirs (#10996). Nothing is typed and nothing is recorded (nothing was withheld
		// from the person's view); the caller asks again on its next pass.
		return Skipped, nil
	}
	if in.Ready != nil {
		if err := in.Ready(ctx); err != nil {
			return Sent, err
		}
	}
	v := in.look(ctx)
	if in.RequireInputBox {
		// A first prompt is not repeated by anything, so it waits for the agent's normal input box (the one wait there is): while a prompt is open (a
		// trust screen) or the screen is still blank, up to launchWait; and for an agent whose box Coral does not recognise, up to launchFallback (waits()).
		w := waits()
		start := time.Now()
		for {
			elapsed := time.Since(start)
			ready := v.skip == "" && !v.leftover && (v.boxShown || elapsed >= w.launchFallback)
			if ready || elapsed >= w.launchWait {
				break
			}
			select {
			case <-ctx.Done():
				return Sent, ctx.Err()
			case <-time.After(w.launchEvery):
			}
			v = in.look(ctx)
		}
	}
	if v.leftover {
		// Coral's own earlier text is still in the box (its Enter did not take): it is sent, and this one is not typed after it, which
		// would join the two. The next send types into an empty box. Nothing was withheld from the person's view: no skip is recorded
		// (what was sent is Coral's text, and a skip left from before is over).
		in.submitLeftover(ctx)
		clearSkipped(in.Name)
		return Skipped, nil
	}
	if v.skip != "" {
		noteSkipped(in, v.skip)
		return Skipped, nil
	}
	enterWithheld, err := gate.typeNow(ctx, in)
	if errors.Is(err, ErrTeamBusy) {
		noteSkipped(in, SkipTeamBusy)
		return Skipped, nil
	}
	if enterWithheld {
		noteSkipped(in, SkipEnter)
		return Skipped, nil
	}
	if err == nil {
		noteDeliveredText(in.Name, in.Text)
		clearSkipped(in.Name)
	}
	return Sent, err
}

// DeliverNow is DeliverAutomated for a person's own Send now (the Operator's button on the agent's page): the same look, except that a screen that cannot be read does not stop it.
// A prompt or menu that is open, or text in the box that is not Coral's, still does: the text and its Enter would answer the one or be sent with the other.
func DeliverNow(ctx context.Context, in AutomatedInput) (Delivery, error) {
	in.force = true
	return DeliverAutomated(ctx, in)
}

// verdict is what the one look at the screen decided.
type verdict struct {
	skip     string // why nothing is typed, "" when the text goes
	leftover bool   // the box holds exactly what Coral typed last: its Enter is what is missing
	boxShown bool   // the agent's normal input box is on the screen (RequireInputBox)
}

// look reads the agent's screen once. A terminal that has no screen to read is typed to (there is nothing to look at); one whose
// screen cannot be read, or is empty, is not.
func (in AutomatedInput) look(ctx context.Context) verdict {
	r, ok := in.Term.(ScreenReader)
	if !ok {
		return verdict{boxShown: true}
	}
	agentType, sessionID := in.identity()
	screen, err := r.AgentScreen(ctx, in.Name, agentType, sessionID)
	if err != nil || strings.TrimSpace(screenText(screen)) == "" {
		if in.force {
			return verdict{boxShown: true} // a person chose to send: only a prompt or a draft that is seen stops it
		}
		return verdict{skip: SkipUnreadable}
	}
	open, why := PromptOnScreen(screen)
	if open && in.blocks(why, agentType, screen) {
		return verdict{skip: SkipPrompt}
	}
	box, haveBox := inputBoxText(screen)
	v := verdict{boxShown: haveBox || InputBoxOnScreen(screen)}
	if !haveBox {
		return v // a readable screen with no box Coral recognises: the text goes (the harness queues it)
	}
	if emptyBox(box, in.styledSuggestionOnly(ctx, agentType, sessionID)) {
		gate.forgetTyped(in.Name) // the box is empty: whatever Coral typed was taken, and it is not Coral's leftover any more
		return v
	}
	if memo, ok := gate.typedFor(in.Name); ok && ownBox(box, memo, gate.now()) {
		v.leftover = true
		return v
	}
	v.skip = SkipDraft
	return v
}

// blocks reports whether the prompt on screen (why, from PromptOnScreen) is one the text must not be typed into. A footer alone, or one drawn
// while the agent works, is not a menu: the text goes. Claude's session survey ("1: Bad ... 0: Dismiss") takes single digit keys and nothing
// else, so a text that does not start with a digit is typed over it (it is ignored there, and the agent is not left deaf to the board until
// a person dismisses it); a text that starts with one would answer it, and is skipped. A bracketed paste is ignored by a menu (#3457).
func (in AutomatedInput) blocks(why, agentType, screen string) bool {
	if !isPromptHold(why) || AgySlashMenuFor(agentType, in.Text, screen) {
		return false
	}
	if isClaudeSurvey(why) {
		t := strings.TrimSpace(in.Text)
		return t == "" || (t[0] >= '0' && t[0] <= '9')
	}
	return true
}

// isClaudeSurvey: the reason PromptOnScreen gives for Claude Code's session survey (its choices end in "0: Dismiss").
func isClaudeSurvey(why string) bool {
	return strings.HasPrefix(why, dialogWhy) && strings.Contains(strings.ToLower(why), "dismiss")
}

// emptyBox: nothing in the box, the agent's own placeholder, or Claude's faint prompt suggestion.
func emptyBox(box string, suggestionOnly bool) bool {
	return strings.TrimSpace(box) == "" || (boxPlaceholder(box) && !strings.Contains(box, pastePlaceholder)) || suggestionOnly
}

// pasteLeftoverWindow is how long after Coral pasted a long text a paste placeholder in the box is taken to be that text still waiting for its Enter.
const pasteLeftoverWindow = 3 * time.Minute

// ownBox reports whether the box holds exactly the text Coral typed last (decided by an exact match of the squeezed texts, or by the
// placeholder an agent shows for a long paste of Coral's): anything else, a person's words added to ours included, is a draft.
func ownBox(box string, memo typedMemo, now time.Time) bool {
	if memo.text == "" {
		return false
	}
	if strings.Contains(box, pastePlaceholder) {
		// A placeholder says only that something was pasted, not what: a person's own paste looks the same. It is Coral's leftover only when Coral pasted a long text a moment ago (a
		// text that got no Enter is found at the next send); later it is the person's draft, and the Enter is theirs to press.
		return memo.paste && collapsible(memo.text) && now.Sub(memo.at) <= pasteLeftoverWindow
	}
	return squeeze(box) == memo.text
}

// styledSuggestionOnly: Claude's faint prompt suggestion is an empty box (#3468); read from the styled screen when the terminal has one.
func (in AutomatedInput) styledSuggestionOnly(ctx context.Context, agentType, sessionID string) bool {
	if ss, ok := in.Term.(StyledScreenReader); ok {
		if styled, err := ss.AgentScreenStyled(ctx, in.Name, agentType, sessionID); err == nil {
			return suggestionOnly(styled)
		}
	}
	return false
}

// submitLeftover presses the Enter Coral's own earlier text is missing.
func (in AutomatedInput) submitLeftover(ctx context.Context) {
	es, ok := in.Term.(EnterSender)
	if !ok {
		return
	}
	agentType, sessionID := in.identity()
	if err := es.SendEnter(ctx, in.Name, agentType, sessionID); err != nil {
		slog.Warn("automated input: could not send the Enter of Coral's earlier text", "session", in.Name, "sender", in.What, "error", err)
		return
	}
	gate.forgetTyped(in.Name)
}

// typeNow types the text and its Enter in one write (a bracketed paste with its Enter where the terminal can, else the caller's Send),
// with the screen looked at once more just before the Enter: if a prompt opened since the look, the Enter is not pressed.
func (g *inputGate) typeNow(ctx context.Context, in AutomatedInput) (enterWithheld bool, err error) {
	// Coral's automated sends to one team are spaced (#3613): the first goes at once, the next 2-3 s after.
	if err := SpaceTeam(ctx, teamFor(in.Name)); err != nil {
		return false, err
	}
	agentType, sessionID := in.identity()
	check := func(ctx context.Context) bool {
		r, ok := in.Term.(ScreenReader)
		if !ok {
			return true
		}
		screen, err := r.AgentScreen(ctx, in.Name, agentType, sessionID)
		if err != nil {
			return false // cannot look: the Enter is not pressed
		}
		open, why := PromptOnScreen(screen)
		return !(open && in.blocks(why, agentType, screen))
	}
	pctx := tmux.WithBeforeEnter(ctx, check)
	if _, known := BracketedPasteHint(pctx); !known {
		if enabled, known := BracketedPasteFromLog(naming.DefaultLogDir(), agentType, sessionID); known {
			pctx = WithBracketedPasteHint(pctx, enabled) // tmux flattens a multi-line text only when the pane is known not to take a paste
		}
	}
	paste := false
	if ps, ok := in.Term.(PromptSender); ok && in.Paste {
		if enabled, known := BracketedPasteHint(pctx); !known || enabled {
			paste = true
			g.noteTyped(in.Name, in.Text, true)
			err = ps.SendPrompt(pctx, terminalinput.Coral, in.Name, in.Text, agentType, sessionID)
			if errors.Is(err, ErrBracketedPasteUnavailable) {
				paste = false
				err = nil
			}
		}
	}
	if !paste {
		g.noteTyped(in.Name, in.Text, false)
		err = in.Send(pctx)
	}
	if errors.Is(err, tmux.ErrEnterWithheld) {
		return true, nil
	}
	return false, err
}

// AutoAcceptSend is the one automated path allowed to type into an open prompt: the opt-in auto-accept feature answering an approval
// it judged safe. It is logged in the input debug log. Nothing else may call it (a test enforces that).
func AutoAcceptSend(ctx context.Context, name string, send func(ctx context.Context) error) error {
	inputlog.Note(name, inputlog.Keys, "[auto-accept answers an approval prompt]")
	return send(ctx)
}
