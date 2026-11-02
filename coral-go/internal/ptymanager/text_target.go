package ptymanager

import "context"

// TextTargetChecker is implemented by terminals that can say text must not be typed into them at all now (Windows ConPTY): a terminal whose own shell is cmd, an agent that started a cmd,
// or a program below the agent that reads the terminal. cmd runs a program from the current folder before it looks on PATH, so a line typed into it can run a file a repository holds,
// whatever the line's first word is; and a program that reads the terminal takes text meant for the agent. A terminal that does not implement it is not refused here (tmux has its
// own foreground job, checked by NoticeBlocked).
type TextTargetChecker interface {
	AgentTextRefused(ctx context.Context, name, agentType, sessionID string) (refused bool, why string)
}

// textRefused asks the send's terminal (TextTargetChecker) whether text may not be typed into it now.
func textRefused(ctx context.Context, in AutomatedInput) (bool, string) {
	c, ok := in.Term.(TextTargetChecker)
	if !ok {
		return false, ""
	}
	agentType, sessionID := in.identity()
	return c.AgentTextRefused(ctx, in.Name, agentType, sessionID)
}
