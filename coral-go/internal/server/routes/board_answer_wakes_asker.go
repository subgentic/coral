package routes

import (
	"context"
	"log/slog"
	"time"

	"github.com/subgentic/coral/internal/naming"
)

// The Operator's answer to an agent's question wakes the asker if it was put to sleep after it asked (#19901): the answer is a board post that tags the asker, and a post never wakes a manual sleeper, so the answer sat
// unread (as the send-back of #19897 did). Only the Operator's own typed answer reaches here (the caller checked), and an archived agent is not woken: it is gone. The wake runs in the background: the answer does not
// wait for the agent's input box.
func (h *BoardHandler) wakeAskerForOperator(project, asker string) {
	if h.operatorWaker == nil || h.bs == nil || asker == "" {
		return
	}
	sub, err := h.bs.GetProjectSubscription(context.Background(), project, asker)
	if err != nil || sub == nil {
		return
	}
	sid := naming.SessionIDFromName(sub.SessionName)
	if sid == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		if !h.operatorWaker(ctx, sid) {
			slog.Info("[ask answer] the asker was not woken (it is archived, or could not start)", "board", project, "asker", asker)
		}
	}()
}
