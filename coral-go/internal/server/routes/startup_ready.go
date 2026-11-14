package routes

import (
	"context"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/ptymanager"
)

// startupReadyState reports that an agent that has sent no event yet is sitting at its own input box with no prompt open: it is up and waiting for a message (#15952). The row's "starting"
// ("Codex is starting" in the chat) and "not_started" ("Waiting in the terminal", row state check_terminal) both come from the ABSENCE of a first hook event, and a CLI that fires no hook until
// its first turn (Codex, Antigravity, Pi, Hermes) never sends one while it waits, so both stayed on until the person typed (the send's own event was the first). The screen is the evidence the
// notices should follow, not the missing event: with the box on screen neither is true. A prompt open on the screen (a trust menu, a hook review, a sign-in) is not a box (InputBoxOnScreen is false
// then), so those stay as they were.
//
// Read only for an agent whose input box Coral recognises, through the per-agent cache of the other startup reads (at most once per loginScreenTTL, or once while the terminal writes nothing), under
// its own key. Presentation only: it never decides a send or an approval.
func (h *SessionsHandler) startupReadyState(name, agentType, sessionID string) bool {
	if sessionID == "" || name == "" || agentType == at.Terminal || !ptymanager.InputBoxKnown(agentType) {
		return false
	}
	stamp := ""
	if stamper, _ := h.backend.(ptymanager.OutputStamper); stamper != nil {
		if st, ok := stamper.OutputStamp(agentType, sessionID); ok {
			stamp = st
		}
	}
	on, _ := h.startupScreens.read(promptReadKey(sessionID, name, agentType)+startupReadySuffix, stamp, time.Now(), func() (bool, string) {
		ctx, cancel := context.WithTimeout(context.Background(), loginScreenTimeout)
		defer cancel()
		screen, err := h.agentScreen(ctx, name, agentType, sessionID, stamp)
		if err != nil {
			return false, ""
		}
		return ptymanager.InputBoxOnScreen(screen), ""
	})
	return on
}

const startupReadySuffix = "|ready"
