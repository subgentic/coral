package routes

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #7355: the feed names what changed. A connection remembers the goals counter it last saw per board and is sent the events above it, at most 50 a frame, with goal_events_gap when it cannot be told
// everything (more than 50, or the window does not reach back to the counter it saw: pruned past, or events from before the table existed). A connection that starts gets none. Ids and kinds only.
func eventsTick(briefs map[string]board.GoalsBrief, events map[string][]board.GoalEvent) *wsTick {
	t := goalsTick(briefs)
	t.goalEvents = events
	return t
}

func evRun(boardID string, goal int64, kind string, from, to int64) []board.GoalEvent {
	var out []board.GoalEvent
	for s := from; s <= to; s++ {
		out = append(out, board.GoalEvent{Board: boardID, Goal: goal, Kind: kind, Seq: s})
	}
	return out
}

func TestFeedNamesTheGoalEventsSinceTheCounterTheConnectionSaw(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	hb := 15 * time.Second
	newFeed := func() *coralFeed {
		return &coralFeed{prevSessions: map[string]string{}, prevByKey: map[string]map[string]any{}, prevRunsJSON: "[]", prevServersJSON: "null", firstMessage: true}
	}
	send := func(f *coralFeed, tick *wsTick) map[string]any {
		msg, kind := f.frame(tick, nil, nil, nil, now, hb)
		if msg != nil {
			f.sent(kind, tick, nil, nil, now)
		}
		return msg
	}
	events := func(m map[string]any) []board.GoalEvent {
		raw, ok := m["goal_events"]
		if !ok {
			return nil
		}
		b, _ := json.Marshal(raw)
		var out []board.GoalEvent
		require.NoError(t, json.Unmarshal(b, &out))
		return out
	}

	// A connection that starts gets none, even when events exist: its first frame carries the brief and the page loads the lists.
	f := newFeed()
	first := send(f, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 1, Seq: 3}}, map[string][]board.GoalEvent{"team-a": evRun("team-a", 7, "goal_created", 1, 3)}))
	assert.NotContains(t, first, "goal_events")
	assert.NotContains(t, first, "goal_events_gap")

	// One change: the diff names it, in the shape {board, goal, kind, seq}; nothing else of the goal.
	win := evRun("team-a", 7, "goal_created", 1, 3)
	win = append(win, board.GoalEvent{Board: "team-a", Goal: 7, Kind: "goal_closed", Seq: 4})
	msg := send(f, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 0, Seq: 4}}, map[string][]board.GoalEvent{"team-a": win}))
	require.NotNil(t, msg)
	assert.Equal(t, []board.GoalEvent{{Board: "team-a", Goal: 7, Kind: "goal_closed", Seq: 4}}, events(msg), "only the events above the counter it saw")
	assert.NotContains(t, msg, "goal_events_gap")
	raw, _ := json.Marshal(msg["goal_events"])
	assert.JSONEq(t, `[{"board":"team-a","goal":7,"kind":"goal_closed","seq":4}]`, string(raw))

	// Nothing changed: nothing at all (no events, no frame).
	assert.Nil(t, send(f, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 0, Seq: 4}}, map[string][]board.GoalEvent{"team-a": win})))

	// Two boards: each is read from its own counter, in the order of the board then the counter.
	two := map[string]board.GoalsBrief{"team-a": {Open: 0, Seq: 5}, "team-b": {Open: 1, Seq: 2}}
	more := map[string][]board.GoalEvent{"team-a": append(append([]board.GoalEvent{}, win...), board.GoalEvent{Board: "team-a", Goal: 8, Kind: "task_linked", Seq: 5}), "team-b": evRun("team-b", 9, "goal_created", 1, 2)}
	msg = send(f, eventsTick(two, more))
	got := events(msg)
	require.Len(t, got, 3)
	assert.Equal(t, board.GoalEvent{Board: "team-a", Goal: 8, Kind: "task_linked", Seq: 5}, got[0])
	assert.Equal(t, []int64{1, 2}, []int64{got[1].Seq, got[2].Seq}, "a board that appeared since the connection started is told all it has")
	assert.NotContains(t, msg, "goal_events_gap", "team-b's events start at 1: nothing is missing")

	// More than 50 at once: the first 50, and the gap flag (the page then refetches).
	a := evRun("team-a", 7, "goal_updated", 6, 120)
	msg = send(f, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 0, Seq: 120}, "team-b": {Open: 1, Seq: 2}}, map[string][]board.GoalEvent{"team-a": a[len(a)-51:], "team-b": evRun("team-b", 9, "goal_created", 1, 2)}))
	got = events(msg)
	assert.LessOrEqual(t, len(got), 50, "at most 50 a frame")
	assert.Equal(t, true, msg["goal_events_gap"])

	// Pruned past: the window starts above the counter the connection saw, so something is missing: the gap flag, with the events there are.
	g := newFeed()
	send(g, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 1, Seq: 10}}, nil))
	msg = send(g, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 1, Seq: 40}}, map[string][]board.GoalEvent{"team-a": evRun("team-a", 7, "goal_updated", 31, 40)}))
	assert.Equal(t, true, msg["goal_events_gap"], "events 11 to 30 are not there")
	assert.Len(t, events(msg), 10)

	// A counter that moved with no event at all (a change from before the events table): the gap flag, no events.
	h := newFeed()
	send(h, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 1, Seq: 10}}, nil))
	msg = send(h, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 2, Seq: 11}}, nil))
	assert.Equal(t, true, msg["goal_events_gap"])
	assert.NotContains(t, msg, "goal_events")

	// One counter step with two events (a task moved from one goal to another): both are sent, no gap.
	k := newFeed()
	send(k, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 1, Seq: 10}}, nil))
	msg = send(k, eventsTick(map[string]board.GoalsBrief{"team-a": {Open: 1, Seq: 11}}, map[string][]board.GoalEvent{"team-a": {{Board: "team-a", Goal: 1, Kind: "task_unlinked", Seq: 11}, {Board: "team-a", Goal: 2, Kind: "task_linked", Seq: 11}}}))
	assert.Len(t, events(msg), 2)
	assert.NotContains(t, msg, "goal_events_gap")
}

// An agent's socket sees the events of its own board only (the brief it gets stays the ids-and-counts one it always had); a socket with no board sees none.
func TestAgentSocketGetsOnlyItsOwnBoardsGoalEvents(t *testing.T) {
	rows := []map[string]any{{"session_id": "sess-a", "board_project": "team-a", "name": "A"}, {"session_id": "sess-b", "board_project": "team-b", "name": "B"}, {"session_id": "sess-c", "name": "C"}}
	all := map[string][]board.GoalEvent{"team-a": evRun("team-a", 1, "goal_updated", 1, 2), "team-b": evRun("team-b", 2, "goal_updated", 1, 2)}
	tick := eventsTick(map[string]board.GoalsBrief{"team-a": {Seq: 2}, "team-b": {Seq: 2}}, all)
	tick.sessions = rows
	a := scopeTickForAgent(tick, "sess-a")
	assert.Equal(t, map[string][]board.GoalEvent{"team-a": all["team-a"]}, a.goalEvents, "its own board's events")
	c := scopeTickForAgent(tick, "sess-c")
	assert.Empty(t, c.goalEvents, "an agent with no board sees none")
	assert.Len(t, tick.goalEvents, 2, "the shared tick is not changed")
	unknown := scopeTickForAgent(tick, "no-such-session")
	assert.Empty(t, unknown.goalEvents)
}

// The shared tick is built from the store: the newest 51 events of the boards that have goals, and nothing for a board that has none.
func TestWSTickBuildsTheGoalEventsWindowFromTheStore(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewSessionsHandler(db, &config.Config{LogDir: t.TempDir()}, nil, newMockTerminal(), bs)
	ctx := t.Context()
	g, err := h.bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship", CreatedBy: "Operator"})
	require.NoError(t, err)
	for i := 0; i < 60; i++ {
		title := "Ship " + string(rune('A'+i%26)) + string(rune('a'+i/26))
		_, err := h.bs.UpdateGoal(ctx, "team", g.ID, board.GoalUpdate{Title: &title})
		require.NoError(t, err)
	}
	req := httptest.NewRequest("GET", "/ws/coral", nil)
	p := h.buildWSLocalPart(req, false, nil)
	require.Contains(t, p.goalEvents, "team")
	assert.Len(t, p.goalEvents["team"], goalEventsWindow, "the newest window, no more")
	assert.Equal(t, 51, goalEventsWindow)
	assert.Equal(t, p.goals["team"].Seq, p.goalEvents["team"][goalEventsWindow-1].Seq, "ending at the board's counter")

	// a board whose counter did not move since the last build is served from the cache, not read again
	again := h.buildWSLocalPart(req, false, p)
	assert.Equal(t, p.goalEvents["team"], again.goalEvents["team"])
	title := "Moved"
	_, err = h.bs.UpdateGoal(ctx, "team", g.ID, board.GoalUpdate{Title: &title})
	require.NoError(t, err)
	next := h.buildWSLocalPart(req, false, again)
	assert.Equal(t, next.goals["team"].Seq, next.goalEvents["team"][goalEventsWindow-1].Seq, "a change shows in the next build")
}
