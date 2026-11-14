package routes

import (
	"context"
	"fmt"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
)

// restartBriefText is what a restarted agent is told about the work it held (#16893). A restart is a fresh conversation: the board still has the task the agent had claimed, but the agent
// knows nothing of it, and said it had no task while its chat still showed the history. The brief names the task it was in the middle of, and points it at the board and its folder.
// It rides in the launch prompt only; the stored prompt (the one the next restart starts from) is not changed.
func restartBriefText(task *board.Task, folder string) string {
	if task == nil {
		return ""
	}
	title := strings.Join(strings.Fields(task.Title), " ")
	if r := []rune(title); len(r) > 200 {
		title = string(r[:200]) + "…"
	}
	var b strings.Builder
	b.WriteString("[Coral restart] You were restarted, so this is a new conversation: you do not remember the earlier one. ")
	fmt.Fprintf(&b, "Before the restart you had claimed Task #%d and were in the middle of it: %s. ", task.ID, title)
	fmt.Fprintf(&b, "It is still yours and still in progress. Read it with 'coral-board task show %d', read what the team has said with 'coral-board read', ", task.ID)
	if folder != "" {
		fmt.Fprintf(&b, "look at the work already in your folder (%s) and the git history there, ", folder)
	}
	b.WriteString("then carry on from where it stands. Do not start the task over.")
	return b.String()
}

// restartBrief reads the task the restarting agent holds on its board, "" when it holds none (or there is no board).
func (h *SessionsHandler) restartBrief(ctx context.Context, p *restartPlan) string {
	if h.bs == nil || p.board == "" {
		return ""
	}
	role := naming.SubscriberID(p.displayName, p.agentType)
	return restartBriefText(h.bs.ActiveTaskForSubscriber(ctx, p.board, role), p.workdir)
}

// withRestartBrief adds the brief after the agent's own prompt.
func withRestartBrief(prompt, brief string) string {
	if brief == "" {
		return prompt
	}
	if strings.TrimSpace(prompt) == "" {
		return brief
	}
	return strings.TrimRight(prompt, "\n") + "\n\n" + brief
}
