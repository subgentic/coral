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
	drivens := map[string]goalDoneDrivenState{} // read once per board (#21461)
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
		if g.State == board.GoalActive && g.Rollup.Total > 0 && g.Rollup.Done == g.Rollup.Total && g.MovedOpen == 0 { // a goal that looks done: the rule of Needs you decides whether the row is held back (#21461)
			d, ok := drivens[g.BoardID]
			if !ok {
				d = h.goalDoneDriven(r.Context(), g.BoardID)
				drivens[g.BoardID] = d
			}
			if d.skips(*g) { // read only: the "shown once" entry is written where the row is listed (the done-state route's "listed", Needs you's read), never by a read of the goals (#21470)
				st.Held = true
			}
		}
		if st.Hidden != "" || st.Read || st.Held {
			g.DoneState = &st
		}
	}
}
