package routes

import (
	"regexp"
	"strings"
)

// Codex's "Approaching rate limits" notice (#14728 part (a), #14774; Security's conditions, #194701) is the second lasting choice a Needs you row may answer, as a named exception found by the menu's STRUCTURE, in the
// shape of the folder-trust Yes (#14110): the title, then exactly three numbered options in this order: "Switch to <model> ...", "Keep current model", "Keep current model (never show again) ...". Any other count,
// order, wording or extra option is not the notice and gets no offer. Only the person's own dashboard is offered it (never a Hub or tunnel viewer: the flag is not sent to anyone else); the answer re-reads the screen and
// refuses with 409 rate_limit_changed, typing nothing, unless it is still this notice with the same model; the row asks once more before choice 1 (it changes the model the agent runs with) and choice 3 (it stops the
// reminder for good).

const rateLimitTitle = "Approaching rate limits"

// rateLimitOffer is what a row is told it may draw: the model the notice offers to switch to, read from the screen's own option, never from the agent's words elsewhere.
type rateLimitOffer struct {
	Model string `json:"model"`
}

// rateLimitModelRe is a model name as text: no spaces, no markup, no control character, at most 64 characters.
var rateLimitModelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$`)

// rateLimitNotice is the model Codex's notice offers to switch to when s is exactly that notice, else "".
func rateLimitNotice(s promptScreen) string {
	if s.Multi || s.Unnumbered || len(s.Options) != 3 {
		return ""
	}
	q := strings.TrimSpace(s.Question)
	if q != rateLimitTitle && !strings.HasPrefix(q, rateLimitTitle+" ") {
		return ""
	}
	for i, o := range s.Options {
		if o.N != i+1 || (o.Action != "" && o.Action != "select") {
			return ""
		}
	}
	first := strings.Fields(s.Options[0].Label)
	if len(first) < 3 || !strings.EqualFold(first[0], "switch") || !strings.EqualFold(first[1], "to") || !rateLimitModelRe.MatchString(first[2]) {
		return ""
	}
	model := first[2]
	if !strings.Contains(q, "Switch to "+model) { // the question and the first option name the same model
		return ""
	}
	if normalizeLabel(s.Options[1].Label) != "keep current model" {
		return ""
	}
	if !strings.HasPrefix(normalizeLabel(s.Options[2].Label), "keep current model (never show again)") {
		return ""
	}
	return model
}

// markRateLimit sets what the parse found on a Codex notice. The offer to a caller is decided per caller (chat_needs_input.go).
func markRateLimit(agentType string, s *promptScreen) {
	if agentType == "codex" {
		s.rateLimitModel = rateLimitNotice(*s)
	}
}
