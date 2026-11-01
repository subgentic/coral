package ptymanager

import (
	"context"
	"regexp"
	"strings"
	"time"
)

// Hermes (#11831): on the first interactive start of a home it asks "Help improve Hermes?" with two choices, "Share with Nous" and "No thanks", the cursor on "No thanks" (v0.22.5, #11715). Nothing answers it in
// an agent Coral launched, and the first prompt would be typed into it. Coral answers with Enter, and ONLY when the question is on screen and the choice the cursor is on is exactly "No thanks": the default, never
// a choice that shares anything.

var (
	hermesTelemetryQuestion = regexp.MustCompile(`(?m)^\s*Help improve Hermes\?\s*$`)
	hermesTelemetrySelected = regexp.MustCompile(`(?m)^\s*(?:→|>|❯)?\s*\(●\)\s*(.+?)\s*$`)
)

// HermesTelemetryOnScreen reports whether screen shows Hermes's telemetry question with "No thanks" selected.
func HermesTelemetryOnScreen(screen string) bool {
	text := screenText(screen)
	if !hermesTelemetryQuestion.MatchString(text) {
		return false
	}
	m := hermesTelemetrySelected.FindAllStringSubmatch(text, -1)
	return len(m) == 1 && strings.EqualFold(m[0][1], "No thanks")
}

// AnswerHermesTelemetry watches the agent's screen for up to wait (every `every`) and presses Enter once when the question shows with "No thanks" selected, then returns true as soon as the screen no longer shows
// it. term must read the screen (ScreenReader) and press Enter (EnterSender); one that cannot does nothing. It returns false when the question never showed, or showed with another choice selected.
func AnswerHermesTelemetry(ctx context.Context, term any, name, agentType, sessionID string, wait, every time.Duration) bool {
	reader, ok1 := term.(ScreenReader)
	enter, ok2 := term.(EnterSender)
	if !ok1 || !ok2 {
		return false
	}
	deadline := time.Now().Add(wait)
	pressed := false
	for {
		if ctx.Err() != nil {
			return false
		}
		if screen, err := reader.AgentScreen(ctx, name, agentType, sessionID); err == nil {
			if HermesTelemetryOnScreen(screen) {
				if !pressed {
					if enter.SendEnter(ctx, name, agentType, sessionID) != nil {
						return false
					}
					pressed = true
				}
			} else if pressed {
				return true
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-time.After(every):
		case <-ctx.Done():
			return false
		}
	}
}
