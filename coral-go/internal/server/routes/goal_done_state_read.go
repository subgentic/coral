package routes

import (
	"net/http"
	"strconv"

	"github.com/subgentic/coral/internal/board"
)

// The done-state of a goal on the way out (#14047): GET /api/goals, a board's goals and one goal carry what the Operator did to each goal's "looks done" row (done_state: hidden "dismissed" or "not_yet", read), read from the
// same two saved lists the done-state route writes (goal_done_hidden, goal_done_read), so a Dismiss, Not yet or read made through a Hub is there after a reload. For the Operator's own read alone: the person at this
// computer, and through Coral Hub the account this computer is linked to (starVisible, the rule of the Operator's stars: what they pinned and opened is their own attention). An agent's token and a Hub viewer, guest or guide
// get the goals as before, with no done_state.

// attachGoalDoneState sets DoneState on each goal the Operator's read may carry it for.
func (h *BoardHandler) attachGoalDoneState(r *http.Request, goals ...*board.Goal) {
	if len(goals) == 0 || agentCaller(r) || !starVisible(r) || (h.goalDoneHidden == nil && h.goalDoneRead == nil) {
		return
	}
	hidden, read := h.goalDoneHiddenSet(r.Context()), h.goalDoneReadSet(r.Context())
	if len(hidden) == 0 && len(read) == 0 {
		return
	}
	for _, g := range goals {
		if g == nil {
			continue
		}
		id := strconv.FormatInt(g.ID, 10)
		var st board.GoalDoneState
		switch {
		case hidden[g.BoardID+"|"+id+"|*"]:
			st.Hidden = "dismissed"
		case hidden[goalDoneKey(g.BoardID, g.ID, g.Rollup.Total)]:
			st.Hidden = "not_yet"
		}
		st.Read = read[goalDoneReadKey(g.BoardID, g.ID, g.Rollup.Total, g.UpdatedAt)]
		if st.Hidden != "" || st.Read {
			g.DoneState = &st
		}
	}
}
