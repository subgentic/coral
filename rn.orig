package routes

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/secrets"
)

const maxRosterRole = 120

// teamRosterNote is what the Orchestrator seat is told about the team it leads (#17168): each other member's name, type and a cut of what it was set up to do, so its plan uses those names and roles and does not invent others
// ("Builder", "Reviewer"). "" when the team has no other named member. The members' words are the team's own, cut to one line each.
func teamRosterNote(members []launchTeamAgent, self string, mayLaunch bool) string {
	var lines []string
	for _, m := range members {
		name := strings.TrimSpace(m.Name)
		if name == "" || strings.EqualFold(name, strings.TrimSpace(self)) {
			continue
		}
		line := fmt.Sprintf("- %s", noteLine(name, 64))
		if m.AgentType != "" {
			line += fmt.Sprintf(" (%s)", noteLine(m.AgentType, 24))
		}
		if role := rosterRole(name, m.Prompt); role != "" {
			line += fmt.Sprintf(": %q", role)
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return ""
	}
	missing := "say so and ask the Operator to add that agent."
	if mayLaunch {
		missing = "add that member yourself, as described below, and say so." // the Operator's grant is on (#17622)
	}
	return "Your team's members, by their exact names and roles. Plan with these members and these names; do not invent roles the team does not have (such as a Builder or a Reviewer), and if the work needs a role nobody here has, " + missing + "\n" + strings.Join(lines, "\n")
}

// youAreOpening is a prompt's opening sentence that only says who the member is ("You are the Lead Developer."): the roster already lists the name, so the line is worth what comes after it.
var youAreOpening = regexp.MustCompile(`(?i)^you are (?:an? |the )?[^.!?]{0,80}[.!?]\s+`)

// rosterRole is the line a member's launch prompt gives the roster (#17610): the prompt on one line, without an opening "You are <the name>." sentence that repeats what the name already says, with anything that looks like a secret
// redacted before it is copied into the Orchestrator's prompt (a prompt can carry a token or a key), cut to maxRosterRole. A member has no stored role or title beside its name (the name is its job title), so the prompt is all there is;
// "" when there is nothing left, or when the text cannot be checked.
func rosterRole(name, prompt string) string {
	text := noteLine(prompt, 600)
	if loc := youAreOpening.FindStringIndex(text); loc != nil && strings.Contains(strings.ToLower(text[:loc[1]]), strings.ToLower(name)) && loc[1] < len(text) {
		text = text[loc[1]:]
	}
	out, err := secrets.Redactor().Text([]byte(text))
	if err != nil {
		return ""
	}
	return noteLine(string(out), maxRosterRole)
}
