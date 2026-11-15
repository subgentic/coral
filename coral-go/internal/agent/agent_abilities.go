package agent

// boardAbilities, when set (the server sets it at startup), is asked for the short "What you can do on this team" section an Orchestrator's system prompt carries (#17622): one line for each team setting that changes
// what the Orchestrator may do, composed from the team's settings as they are NOW. Every launch, restart and wake builds the command through the agent's LaunchCommand, so the section is never a stored copy that
// a later change to a setting leaves stale. The agent type is passed because the builder knows it and the params do not carry it.
var boardAbilities func(p LaunchParams, agentType string) string

// SetBoardAbilities sets (or, with nil, clears) the source of the Orchestrator's "What you can do on this team" section.
func SetBoardAbilities(f func(p LaunchParams, agentType string) string) { boardAbilities = f }

// withBoardAbilities adds the section to an Orchestrator's board system prompt; any other role's prompt, and a prompt with no board, is as it was.
func withBoardAbilities(system string, p LaunchParams, agentType string) string {
	if boardAbilities == nil || system == "" || p.BoardName == "" || !isOrchestratorRole(p.Role) {
		return system
	}
	if section := boardAbilities(p, agentType); section != "" {
		return system + "\n\n" + section
	}
	return system
}
