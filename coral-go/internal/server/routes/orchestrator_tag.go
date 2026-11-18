package routes

import "github.com/subgentic/coral/internal/board"

// orchestratorTag is the leading "@<orchestrator> " of a Coral line that needs the Orchestrator and would be board-only for it otherwise (#19608): empty when the team has no orchestrator name, and when the
// line is about the orchestrator itself (except names who: the agent the line is about, or who did it), so there is never a bare "@ " and an orchestrator is not tagged in its own news (#19633).
func orchestratorTag(orch string, except ...string) string {
	if orch == "" {
		return ""
	}
	for _, who := range except {
		if who != "" && board.SameIdentity(orch, who) {
			return ""
		}
	}
	return "@" + orch + " "
}
