package ptymanager

import (
	"context"

	"github.com/subgentic/coral/internal/tmux"
)

func init() {
	OnSessionEnd(tmux.ForgetAgentProc) // what Coral recorded of the session's agent process is not true of a new one
	registerWatchStopper(tmux.StopAgentWatches)
}

// AgentNoticeTarget implements NoticeTargetChecker for tmux.
func (t *TmuxSessionTerminal) AgentNoticeTarget(ctx context.Context, name, agentType, sessionID string) (ok, wait bool, why string, known bool) {
	v, err := t.client.AgentNoticeVerdict(ctx, name, agentType, sessionID)
	if err != nil {
		return false, false, "", false
	}
	return v.OK, v.Wait, v.Reason, true
}
