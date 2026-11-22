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

// A row blocked by a usage limit (#20692): {kind: "usage_limit", vendor: "claude"|"codex"|"agy", reset_at: RFC 3339 UTC or null}. reset_at is null when the CLI printed no time (or none that reads as one). Claude's comes from its transcript's
// rate-limit error (read when the error was recorded, so the transcript's text cap cannot cut it off), Codex's and agy's from the health monitor's last screen read (a mark lives usageLimitMaxAge). A limit whose reset has come is over: no mark.
// Only an awake agent; a first paint that skips expensive reads leaves the Claude read out (a later row fills it).
const (
	blockedUsageLimit = "usage_limit"
	usageLimitMaxAge  = 10 * time.Minute
)

func (h *SessionsHandler) usageLimitBlocked(sessionID, workingDir, agentType string, sleeping, skipExpensive bool) map[string]any {
	if sleeping {
		return nil
	}
	var vendor string
	var resetAt time.Time
	var limited bool
	now := time.Now()
	switch agentType {
	case at.Claude, "":
		if skipExpensive || h.jsonl == nil || sessionID == "" {
			return nil
		}
		e, ok := h.jsonl.ReadClaudeAPIError(sessionID, workingDir)
		if !ok || !e.UsageLimit() {
			return nil
		}
		vendor, limited = "claude", true
		resetAt, _ = e.ResetsAt()
		if !resetAt.IsZero() && !resetAt.After(now) {
			return nil // the reset has come: the agent may work again
		}
	case at.Codex:
		vendor = "codex"
		resetAt, limited = ptymanager.UsageLimitOf(sessionID, usageLimitMaxAge, now)
	case at.Agy, at.Antigravity:
		vendor = "agy"
		resetAt, limited = ptymanager.UsageLimitOf(sessionID, usageLimitMaxAge, now)
	}
	if !limited {
		return nil
	}
	var when any
	if !resetAt.IsZero() {
		when = resetAt.UTC().Format(time.RFC3339)
	}
	return map[string]any{"kind": blockedUsageLimit, "vendor": vendor, "reset_at": when}
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
