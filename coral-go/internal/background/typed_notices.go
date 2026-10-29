package background

import (
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// typedHealthCheckOpener starts every team health check typed into the recipient's terminal (board.TypedOpeners).
const typedHealthCheckOpener = "[Coral health check]"

// typedHealthCheck is the team health check as it is TYPED (goal #7, #378): the check quotes what agents said and names their tasks, and
// the terminal it is typed into may be a shell (an exited agent's, or one a person started), so the line keeps only what
// board.TypedText keeps and starts with a fixed opener, never with Coral's composed words. The check as composed is unchanged everywhere
// else (what it has shown is recorded from it).
func typedHealthCheck(text string) string {
	return typedHealthCheckOpener + " " + board.TypedText(strings.TrimPrefix(strings.TrimSpace(text), typedHealthCheckOpener))
}

// typedHealthLine is one health line typed to a team member ("[Coral health] " and what the check found about them).
func typedHealthLine(detail string) string {
	return "[Coral health] " + board.TypedText(detail)
}

// typedHealth is what the health monitor's deliver types: a line to a member keeps its "[Coral health]" opener; anything else is the
// team health check. Done in the deliver itself, the one place the monitor's text reaches a terminal, so what the check composed (and
// records as shown) is unchanged.
func typedHealth(text string) string {
	if detail, ok := strings.CutPrefix(text, "[Coral health] "); ok {
		return typedHealthLine(detail)
	}
	return typedHealthCheck(text)
}
