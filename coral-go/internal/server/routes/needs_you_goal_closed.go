package routes

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	setreg "github.com/subgentic/coral/internal/settings"
)

const goalClosedWindow = 14 * 24 * time.Hour

// SetGoalClosedDismissed tells the board where to read the goals-closed-by-agent the Operator dismissed from Needs you (setting goal_closed_dismissed, #16781). nil: none.
func (h *BoardHandler) SetGoalClosedDismissed(fn func(ctx context.Context) []string) {
	h.goalClosedDismissed = fn
}

// GoalClosedDismissedFrom reads the dismissed list out of the saved settings.
func GoalClosedDismissedFrom(st map[string]string) []string {
	var list []string
	if err := json.Unmarshal([]byte(setreg.Text(st, setreg.GoalClosedDismissed)), &list); err != nil {
		return nil
	}
	if len(list) > goalDoneHiddenMax {
		list = list[len(list)-goalDoneHiddenMax:]
	}
	return list
}

func goalClosedKey(team string, id int64, closedAt string) string {
	return team + "|" + strconv.FormatInt(id, 10) + "|" + closedAt
}

// goalClosedDismissedSet is the saved list as a set.
func (h *BoardHandler) goalClosedDismissedSet(ctx context.Context) map[string]bool {
	return listSet(ctx, h.goalClosedDismissed)
}

// goalClosedItems returns goals in state "done" that were closed by an agent (not the Operator) within the last 14 days, excluding dismissed ones.
func (h *BoardHandler) goalClosedItems(ctx context.Context, project string, dismissed map[string]bool) ([]NeedsYouItem, error) {
	now := time.Now().UTC()
	var items []NeedsYouItem
	cursor := ""
	for {
		page, err := h.bs.GoalPage(ctx, project, board.GoalListQuery{States: []string{board.GoalDone}, Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		for _, g := range page.Goals {
			if !goalClosedByAgent(g, now) {
				continue
			}
			closedAt := ""
			if g.ClosedAt != nil {
				closedAt = *g.ClosedAt
			}
			if dismissed[goalClosedKey(project, g.ID, closedAt)] {
				continue
			}
			line := "Goal #" + strconv.FormatInt(g.ID, 10) + " closed as done by " + strings.TrimSpace(g.ClosedBy)
			text := g.ClosedReason
			if text == "" {
				text = g.Title
			}
			items = append(items, NeedsYouItem{
				Kind: "goal_closed",
				Line: needsYouLine(line + ": " + text),
				Team: project,
				ID:   "goal_closed:" + project + ":" + strconv.FormatInt(g.ID, 10),
				At:   needsYouTime(closedAt),
			})
		}
		if page.NextCursor == "" {
			return items, nil
		}
		cursor = page.NextCursor
	}
}

func goalClosedByAgent(g board.Goal, now time.Time) bool {
	if g.State != board.GoalDone {
		return false
	}
	by := strings.TrimSpace(g.ClosedBy)
	if by == "" || by == "Operator" {
		return false
	}
	if g.ClosedAt == nil || *g.ClosedAt == "" {
		return false
	}
	at, err := time.Parse(time.RFC3339Nano, *g.ClosedAt)
	if err != nil {
		at, err = time.Parse(time.RFC3339, *g.ClosedAt)
		if err != nil {
			return false
		}
	}
	return now.Sub(at) < goalClosedWindow && !now.Before(at.Add(-time.Minute))
}
