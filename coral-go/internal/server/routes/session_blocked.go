package routes

import (
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/ptymanager"
)

// A live row's `blocked` (#13486): {kind: "model_refused", model} on a Codex agent whose model its login refuses, read from the health monitor's last screen read of it (no screen is read for the list). The key
// is absent when nothing blocks the agent. model is "" when the name Codex printed is not a safe one to repeat. A read older than blockedMaxAge says nothing, so the mark goes by itself once Codex works again.
const blockedMaxAge = 2 * time.Minute

const blockedModelRefused = "model_refused"

func blockedField(sessionID, agentType string, sleeping bool) map[string]any {
	if sleeping || agentType != at.Codex {
		return nil
	}
	model, refused := ptymanager.CodexModelRefusalOf(sessionID, blockedMaxAge, time.Now())
	if !refused {
		return nil
	}
	return map[string]any{"kind": blockedModelRefused, "model": model}
}

// modelRefusedNotice is the chat's limit_notice for a Codex agent whose model is refused: the fact in a sentence (#13486). "" when it is not.
func modelRefusedNotice(sessionID, agentType string) string {
	b := blockedField(sessionID, agentType, false)
	if b == nil {
		return ""
	}
	if model, _ := b["model"].(string); model != "" {
		return "Codex refuses its model " + model + ": change the model for this agent."
	}
	return "Codex refuses its model: change the model for this agent."
}
