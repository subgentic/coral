// Package agenttypes defines agent type constants shared across packages.
// This package has no dependencies and can be imported by any other package
// without risk of circular imports.
package agenttypes

import "time"

// Agent type identifiers.
const (
	Claude      = "claude"
	Agy         = "agy"
	Antigravity = "antigravity"
	Gemini      = "gemini"
	Codex       = "codex"
	Pi          = "pi"
	Hermes      = "hermes"
	Opencode    = "opencode"
	Terminal    = "terminal"
)

// CoralSessionMarkerPrefix prefixes a session marker injected into per-agent
// instructions. History parsers use it to map agent-native transcripts back to
// Coral's stable live session IDs.
const CoralSessionMarkerPrefix = "CORAL_SESSION_ID:"

// MinSubmitGap is the least time an agent's TUI needs between text Coral typed or pasted and the Enter that submits it: Hermes reads text and an Enter that arrive together as a paste and leaves the text
// unsent, so its Enter comes a full second after (checked on v0.22.5, #11715). Zero for the others, whose own delays (150-400 ms) stand.
func MinSubmitGap(agentType string) time.Duration {
	if agentType == Hermes {
		return time.Second
	}
	return 0
}
