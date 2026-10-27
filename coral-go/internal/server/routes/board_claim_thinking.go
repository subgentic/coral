package routes

import (
	"context"
	"log/slog"
)

// recordClaimThinking keeps the thinking level the claiming agent is set to on the claimed task (#8915), for the Analytics view's task times by thinking level. A subscriber with no session, a session with
// no level, or a failed write records nothing: the claim itself has succeeded, and a task with no level shows as not recorded.
func (h *BoardHandler) recordClaimThinking(ctx context.Context, project, subscriberID string, taskID int64) {
	if h.sessionThinking == nil {
		return
	}
	sub, err := h.bs.GetProjectSubscription(ctx, project, subscriberID)
	if err != nil || sub == nil || sub.SessionName == "" {
		return
	}
	level := h.sessionThinking(ctx, sub.SessionName)
	if level == "" {
		return
	}
	if err := h.bs.SetClaimThinking(ctx, project, taskID, level); err != nil {
		slog.Warn("could not record a claim's thinking level", "project", project, "task", taskID, "error", err)
	}
}
