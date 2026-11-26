package routes

import (
	"context"
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// retargetSystemReply keeps a reply to a question Coral made itself (the custom-check approval, a health notice) from being refused (#21500). The dashboard opens a reply with "@<asker> ", and Coral's own sender is
// no member of the board, so the unknown-mention rule refused the Operator's words with "no subscriber named Coral". A reply to a system sender's question now speaks to the team's Orchestrator instead of the sender
// (nobody records which agent added the check), or carries no mention when the team has none. The text itself is never changed, and a reply to a question of a member is left as it is.
func (h *BoardHandler) retargetSystemReply(ctx context.Context, project string, replyTo int64, content string) string {
	if replyTo <= 0 || !strings.HasPrefix(content, "@") {
		return content
	}
	asked, err := h.bs.GetMessageByID(ctx, project, replyTo)
	if err != nil || asked == nil || !isSystemAsker(asked.SubscriberID) {
		return content
	}
	lead := "@" + asked.SubscriberID
	if len(content) < len(lead) || !strings.EqualFold(content[:len(lead)], lead) {
		return content
	}
	rest := content[len(lead):]
	if rest != "" && !strings.HasPrefix(rest, " ") && !strings.HasPrefix(rest, "\n") && !strings.HasPrefix(rest, ",") && !strings.HasPrefix(rest, ":") {
		return content // "@CoralX ..." is another name
	}
	rest = strings.TrimLeft(rest, ",: ")
	if orch, _ := h.bs.TeamOrchestrator(ctx, project); orch != "" {
		return "@" + orch + " " + rest
	}
	return rest
}

// isSystemAsker: only Coral's own two senders of questions, compared exactly. Never the Operator, "all", a hub: name or another reserved name: a reply to those keeps its mention, because it decides who the reply reaches.
func isSystemAsker(sender string) bool {
	return sender == board.CoralSender || sender == board.HealthMonitorSender
}
