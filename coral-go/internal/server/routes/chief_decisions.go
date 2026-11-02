package routes

import (
	"context"

	"github.com/subgentic/coral/internal/board"
)

// chiefDecisionSender is who Chief's board shows a decision notice from: a name no agent has, so Chief can tell it from a teammate's message.
const chiefDecisionSender = "Coral Decisions"

// chiefDecisionVerbs is what the notice says for each action it is sent for. Anything else is not a decision Chief is told of.
var chiefDecisionVerbs = map[string]string{
	board.ActApprove:  "approved",
	board.ActDeny:     "declined",
	board.ActChanges:  "asked for changes to",
	board.ActAnswer:   "answered",
	board.ActIgnore:   "closed without an answer",
	board.ActGoalDone: "closed",
}

// tellChief posts one short notice to Chief's board when the Operator decides something on a team Chief fronts (#12171): Chief's board is on that team's list of allowed senders, so Chief is
// already the way the Operator reaches it. Only the verb, the kind, the item's cleaned title, the team's name and who was told are in it: never a file's content, an answer's text or a reason.
// Best effort: a notice that cannot be posted never blocks the decision. who may be empty.
func (h *BoardHandler) tellChief(ctx context.Context, action, kind, team, title, who string) {
	verb, ok := chiefDecisionVerbs[action]
	if !ok || h.bs == nil {
		return
	}
	chief := h.chiefBoardNow(ctx)
	if chief == "" || chief == team {
		return
	}
	id, ok, err := h.bs.CrossTeamID(ctx, chief)
	if err != nil || !ok {
		return
	}
	// Chief hears about a team the Operator named in Settings > Chief, or one whose list of allowed senders holds Chief's board. The list alone was the rule at first; but while the allowlist is off a Chief
	// that messages a team needs no entry, so a team the Operator had set Chief to front heard nothing (#12411).
	if !h.frontedByChief(ctx, team) {
		st, err := h.bs.GetBoardSettings(ctx, team)
		if err != nil || !st.AllowsSender(board.LocalServer, id) {
			return
		}
	}
	text := "The Operator " + verb + " " + kind
	if t := h.noticeText(ctx, chief, title); t != "" {
		text += " " + quoteNotice(t)
	}
	text += " on team " + quoteNotice(h.noticeText(ctx, chief, team)) + "."
	if w := h.noticeText(ctx, chief, who); w != "" {
		text += " " + w + " was told."
	}
	text += " (A decision notice from Coral: tell the Operator in one or two plain lines.)"
	h.postNotice(ctx, chief, text, chiefDecisionSender) // every quoted part went through noticeText above; postNotice is the one place that posts defused text
	if h.notifyFn != nil {
		h.notifyFn(chief)
	}
}
