package routes

import (
	"context"
	"net/http"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// A team agent is Awake, Asleep or Archived (#19673). Stop archives (the session ends, the seat stays); Sleep turns an archived agent into a sleeping one; Start wakes either. The one rule a Stop must keep: a
// team is never left without an Orchestrator by it.

// archiveRefusal says why a team agent must not be archived, as (code, sentence): "" when it may be. It is the board's last Orchestrator (a team with none cannot plan, review or wake anyone) that is refused;
// an agent that is on no board, or a plain worker, may always be archived. The Orchestrator seat itself is refused earlier, by the orchestrator routes (orchTarget).
func (h *SessionsHandler) archiveRefusal(ctx context.Context, sess *store.LiveSession) (code, why string) {
	if h.bs == nil || sess == nil {
		return "", ""
	}
	name := naming.SessionName(sess.AgentType, sess.SessionID)
	sub, err := h.bs.GetSubscriptionBySessionName(ctx, name)
	if err != nil || sub == nil || !board.IsOrchestrator(sub.SubscriberID, sub.JobTitle, sub.CanPeek) {
		return "", ""
	}
	subs, err := h.bs.ListSubscribers(ctx, sub.Project)
	if err != nil {
		return "", ""
	}
	for _, o := range subs {
		if o.ID == sub.ID || !board.IsOrchestrator(o.SubscriberID, o.JobTitle, o.CanPeek) || o.SessionName == "" {
			continue
		}
		if ls, err := h.ss.GetLiveSession(ctx, naming.SessionIDFromName(o.SessionName)); err == nil && ls != nil && ls.IsArchived == 0 {
			return "", "" // another Orchestrator stays
		}
	}
	return "last_orchestrator", "that is this team's only Orchestrator: archiving it would leave the team with none. Start or add another Orchestrator first"
}

// refuseArchive answers a refused archive with 409 and its code, true when it did.
func (h *SessionsHandler) refuseArchive(w http.ResponseWriter, ctx context.Context, sess *store.LiveSession) bool {
	code, why := h.archiveRefusal(ctx, sess)
	if code == "" {
		return false
	}
	orchRefusal(w, http.StatusConflict, code, why)
	return true
}
