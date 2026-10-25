// Send now's forced typing (#7579): the Operator chose to send, so the checks that keep an automated paste waiting for the agent's input box (the box on screen, its text confirmed there, the Enter's
// effect confirmed) are not made. Two refusals remain, because text typed into either would do harm: a real permission, question or menu prompt on the screen, and a draft in the box that is not Coral's.

package ptymanager

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/terminalinput"
	"github.com/subgentic/coral/internal/tmux"
)

// Why a forced send typed nothing.
const (
	ForceRefusedPrompt = "prompt" // a real prompt or menu is open on the agent's screen
	ForceRefusedDraft  = "draft"  // the agent's input box holds text that is not Coral's
)

// forceRefusal is the error of a forced send that typed nothing: the send is still held, and Why says why.
type forceRefusal struct{ Why string }

func (e *forceRefusal) Error() string { return "Send now typed nothing: " + e.Why }

// forcePaste is pasteChecked for a forced send: paste, then Enter unless a real prompt opened meanwhile.
func (g *inputGate) forcePaste(ctx context.Context, in AutomatedInput, ps PromptSender) (enterHeld bool, err error, done bool) {
	agentType, sessionID := in.identity()
	sr, _ := in.Term.(ScreenReader)
	rendered := false
	if rs, ok := in.Term.(RenderedScreen); ok && sr != nil {
		rendered = rs.HasRenderedScreen()
	}
	if sr != nil {
		if screen, serr := sr.AgentScreen(ctx, in.Name, agentType, sessionID); serr == nil {
			if open, why := PromptOnScreen(screen); open && isPromptHold(why) {
				return false, &forceRefusal{Why: ForceRefusedPrompt}, true
			}
			if rendered {
				in.hadPlaceholder = hasPlaceholder(screen)
				switch in.boxState(ctx, screen, agentType, sessionID) {
				case boxOther:
					// Text that is not this send's: Coral's own earlier message is sent first; anyone else's is a draft, never added to.
					held, err, own := g.submitLeftover(ctx, in, sr, screen, agentType, sessionID)
					if !own {
						return false, &forceRefusal{Why: ForceRefusedDraft}, true
					}
					if held || err != nil {
						return held, err, true
					}
				case boxOurs:
					held, err := g.enterAndConfirm(ctx, in, sr, rendered, agentType, sessionID)
					return held, err, true
				case boxUnknown:
					if in.pasteRetry > 0 || in.entered {
						// Pasted already (the hold was for the paste not being seen in a box that cannot be found): the text is most likely there, so only its Enter is pressed, not confirmed.
						es, ok := in.Term.(EnterSender)
						if !ok {
							return false, errors.New("this terminal can't press Enter on its own"), true
						}
						if err := es.SendEnter(ctx, in.Name, agentType, sessionID); err != nil {
							return false, err, true
						}
						g.setLastPasted(in.Name, "")
						return false, nil, true
					}
				}
			}
		}
	}
	pctx := ctx
	if _, known := BracketedPasteHint(ctx); !known {
		if enabled, known := BracketedPasteFromLog(naming.DefaultLogDir(), agentType, sessionID); known {
			pctx = WithBracketedPasteHint(ctx, enabled)
		}
	}
	var promptOpened atomic.Bool
	check := func(ctx context.Context) bool {
		if sr == nil {
			return true
		}
		screen, err := sr.AgentScreen(ctx, in.Name, agentType, sessionID)
		if err != nil {
			return true
		}
		if open, why := PromptOnScreen(screen); open && !AgySlashMenuFor(agentType, in.Text, screen) {
			promptOpened.Store(isPromptHold(why))
			return false
		}
		return true // the text is not looked for in the box: the box may not be on the screen the reader sees
	}
	g.setLastPasted(in.Name, in.Text)
	err = ps.SendPrompt(tmux.WithBeforeEnter(pctx, check), terminalinput.Coral, in.Name, in.Text, agentType, sessionID)
	switch {
	case err == nil:
		g.setLastPasted(in.Name, "") // typed, and not confirmed from the screen
		return false, nil, true
	case errors.Is(err, ErrBracketedPasteUnavailable):
		return false, nil, false
	case errors.Is(err, tmux.ErrEnterWithheld):
		if promptOpened.Load() {
			g.holdPaste(in, "a prompt opened before its Enter", true, kindPrompt)
			return true, nil, true
		}
		return false, nil, false
	}
	return false, err, true
}
