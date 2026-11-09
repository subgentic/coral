package routes

import (
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/tracking"
)

// Inbox telemetry from the server's side (#7512). Each event is built in the tracking package from closed lists; nothing of the item (its id, title, text,
// agent, board, task or file) is passed in. Only a person's own action counts (humanInputCaller, Security's D3): an agent, a script or a session token does
// not, so neither can inflate or steer the numbers.

// inboxActioned records a person's action on an Inbox item. created is when the item began, from the server's own record (the zero time when there is none).
func inboxActioned(r *http.Request, kind, subKind, action string, created time.Time) {
	if !humanInputCaller(r) {
		return
	}
	tracking.TrackInboxActioned(kind, subKind, action, surfaceOf(r), created)
}

// inboxTime reads a stored time (RFC3339, with or without fractions), or gives the zero time.
func inboxTime(s string) time.Time {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t
	}
	return time.Time{}
}

// needsYouKindToInbox maps the needs-you kinds to the Inbox telemetry's.
var needsYouKindToInbox = map[string]string{
	"agent": tracking.InboxAgentWait, "question": tracking.InboxAsk, "wait": tracking.InboxWait, "proposal": tracking.InboxProposal,
	"review": tracking.InboxReview, "goal_done": tracking.InboxGoalDone, "skill": tracking.InboxSkill,
}

// InboxOpenedCounts is what is waiting for the person who opened the Inbox, by kind, as the server sees it (needs-you): counts only.
func (h *BoardHandler) InboxOpenedCounts(r *http.Request) map[string]int {
	items, _, _, err := h.needsYouItems(r)
	if err != nil {
		return nil
	}
	out := map[string]int{}
	for _, it := range items {
		if k, ok := needsYouKindToInbox[it.Kind]; ok {
			out[k]++
		}
	}
	return out
}
