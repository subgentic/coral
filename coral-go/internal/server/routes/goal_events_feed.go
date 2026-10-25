package routes

import (
	"sort"

	"github.com/subgentic/coral/internal/board"
)

// The goal events of the live feed (#7355): what a goals counter move was, ids and a kind only. The tick carries the newest window per board (ws_shared_list.go); each connection is sent the events above
// the counter it last saw (coralFeed.goalEventsFor), at most goalEventsPerFrame, and goal_events_gap when it cannot be told everything: the page then refetches, as it did before events existed.

// ownBoardGoalEvents is the events of the agent's own board: an agent sees no other board's, and an agent with no board sees none (the shared tick is not changed).
// ownBoardGoalScope is the boards an agent's socket is told goal events and gaps for: its own, or none.
func ownBoardGoalScope(boardID string) map[string]bool {
	if boardID == "" {
		return map[string]bool{}
	}
	return map[string]bool{boardID: true}
}

func ownBoardGoalEvents(all map[string][]board.GoalEvent, boardID string) map[string][]board.GoalEvent {
	if boardID == "" {
		return nil
	}
	ev, ok := all[boardID]
	if !ok {
		return nil
	}
	return map[string][]board.GoalEvent{boardID: ev}
}

// goalEventsFor is the events this connection has not been told, in the order of the board then the counter, and whether it was not told everything. A board's events above the counter it last saw
// (prevGoalSeqs; none for a board it never saw) are taken up to the board's counter now; a counter that moved with no event, or whose first event is not the one right above the counter it saw (pruned past,
// or from before the events table), is a gap, and so is more than goalEventsPerFrame in all.
func (f *coralFeed) goalEventsFor(tick *wsTick) (events []board.GoalEvent, gap bool) {
	boards := make([]string, 0, len(tick.goals))
	for id := range tick.goals {
		boards = append(boards, id)
	}
	sort.Strings(boards)
	for _, id := range boards {
		if tick.goalScope != nil && !tick.goalScope[id] {
			continue // an agent's socket: a board it cannot see moving its counter is not a gap in what it can see
		}
		last, now := f.prevGoalSeqs[id], tick.goals[id].Seq
		if now == last {
			continue
		}
		if now < last { // a counter that fell: the board was deleted and made again, so nothing above the old counter means anything: a gap, and the connection reads on from the new counter
			gap = true
			continue
		}
		var mine []board.GoalEvent
		for _, e := range tick.goalEvents[id] {
			if e.Seq > last && e.Seq <= now {
				mine = append(mine, e)
			}
		}
		if len(mine) == 0 || mine[0].Seq != last+1 {
			gap = true
		}
		events = append(events, mine...)
	}
	if len(events) > goalEventsPerFrame {
		events, gap = events[:goalEventsPerFrame], true
	}
	return events, gap
}
