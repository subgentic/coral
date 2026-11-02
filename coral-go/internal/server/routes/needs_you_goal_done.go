package routes

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/subgentic/coral/internal/board"
	setreg "github.com/subgentic/coral/internal/settings"
)

// goalDoneHiddenMax is how many entries of the saved goal_done_hidden list are read: the newest ones the page keeps (it keeps 100).
const goalDoneHiddenMax = 200

// SetGoalDoneHidden tells the board where to read the goals the Operator hid from Needs you (setting goal_done_hidden, #11825): each entry is "<team>|<goal id>|<tasks the goal had>" (Not yet: hides the goal
// until a task is added) or "<team>|<goal id>|*" (Ignore). nil: nothing is hidden.
func (h *BoardHandler) SetGoalDoneHidden(fn func(ctx context.Context) []string) {
	h.goalDoneHidden = fn
}

// GoalDoneHiddenFrom reads the list out of the saved settings: a JSON array of strings, at most goalDoneHiddenMax of them; anything else is an empty list.
func GoalDoneHiddenFrom(st map[string]string) []string {
	var list []string
	if err := json.Unmarshal([]byte(setreg.Text(st, setreg.GoalDoneHidden)), &list); err != nil {
		return nil
	}
	if len(list) > goalDoneHiddenMax {
		list = list[len(list)-goalDoneHiddenMax:]
	}
	return list
}

// goalDoneKey is the entry Not yet writes for a goal at its all-done total.
func goalDoneKey(team string, id int64, total int) string {
	return team + "|" + strconv.FormatInt(id, 10) + "|" + strconv.Itoa(total)
}

// goalDoneItems is the board's active goals whose tasks are all done (at least one task, none open, the state exactly active: the rule the goal screen's all-done box used), as items of Needs you, less the
// ones the Operator hid. One item per goal; a goal that closes, gets a task, or is blocked is no longer one.
func (h *BoardHandler) goalDoneItems(ctx context.Context, project string, hidden map[string]bool, news map[string]int) ([]NeedsYouItem, error) {
	var items []NeedsYouItem
	cursor := ""
	for {
		page, err := h.bs.GoalPage(ctx, project, board.GoalListQuery{States: []string{board.GoalActive}, Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		for _, g := range page.Goals {
			r := g.Rollup
			if g.State != board.GoalActive || r.Total == 0 || r.Done != r.Total {
				continue
			}
			if hidden[goalDoneKey(project, g.ID, r.Total)] || hidden[project+"|"+strconv.FormatInt(g.ID, 10)+"|*"] {
				continue
			}
			items = append(items, NeedsYouItem{Kind: "goal_done", Line: needsYouLine("Goal #" + strconv.FormatInt(g.ID, 10) + " looks done: " + g.Title), Team: project, ID: "goal_done:" + project + ":" + strconv.FormatInt(g.ID, 10), At: needsYouTime(g.UpdatedAt), NewComments: news[goalSubject(project, g.ID)]})
		}
		if page.NextCursor == "" {
			return items, nil
		}
		cursor = page.NextCursor
	}
}

// goalDoneHiddenSet is the saved list as a set, read on every request.
func (h *BoardHandler) goalDoneHiddenSet(ctx context.Context) map[string]bool {
	set := map[string]bool{}
	if h.goalDoneHidden == nil {
		return set
	}
	for _, e := range h.goalDoneHidden(ctx) {
		set[e] = true
	}
	return set
}
