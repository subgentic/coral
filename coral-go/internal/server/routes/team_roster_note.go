package routes

import (
	"fmt"
	"strings"
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
		if role := noteLine(m.Prompt, maxRosterRole); role != "" {
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
