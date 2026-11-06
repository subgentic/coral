package routes

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/tracking"
)

// SetGoalDoneEdit tells the board how to edit a saved list atomically (the settings store's EditSettingList). nil: the route answers 503.
func (h *BoardHandler) SetGoalDoneEdit(fn func(ctx context.Context, key string, max int, edit func([]string) []string) ([]string, error)) {
	h.goalDoneEdit = fn
}

// The states of POST /api/board/{project}/goals/{goalID}/done-state (#13834): what the Operator does to a "Goal looks done" row in Needs you. A closed set; the body has nothing else.
const (
	doneStateNotYet  = "not_yet" // hide it until another task is done (the entry at this all-done total)
	doneStateDismiss = "dismiss" // hide it for good (the entry "<team>|<goal>|*")
	doneStateShow    = "show"    // Undo of the two above: every hiding entry of the goal goes
	doneStateRead    = "read"    // opened: stays listed, stops counting (the entry at this total and last change)
	doneStateUnread  = "unread"  // Mark unread: every read entry of the goal goes
)

// SetGoalDoneState: POST /api/board/{project}/goals/{goalID}/done-state {"state": "not_yet" | "dismiss" | "show" | "read" | "unread"} (the Operator's alone). The Inbox kept these two lists by a PUT of the whole
// setting, which no Hub could be allowed (the setting is tier never: any other key rides with it). This route is the narrow way: the state is a word, the server loads the goal on THIS board and builds the entry
// itself (team from the path's board, the total and the last change from the goal), so no text of the caller's is ever stored, and the goal must exist on the board or the answer is 404.
func (h *BoardHandler) SetGoalDoneState(w http.ResponseWriter, r *http.Request) {
	if !operatorGoalCaller(w, r, "change a goal's row in Needs you") {
		return
	}
	project := urlParam(r, "project")
	id, ok := goalID(w, r)
	if !ok {
		return
	}
	var body struct {
		State string `json:"state"`
	}
	if err := decodeJSONStrict(r, &body); err != nil {
		errBadRequest(w, `send {"state": "not_yet" | "dismiss" | "show" | "read" | "unread"}`)
		return
	}
	switch body.State {
	case doneStateNotYet, doneStateDismiss, doneStateShow, doneStateRead, doneStateUnread:
	default:
		errBadRequest(w, `state is one of not_yet, dismiss, show, read, unread`)
		return
	}
	if h.bs == nil || h.goalDoneEdit == nil {
		writeError(w, http.StatusServiceUnavailable, "board_unavailable", "the board is not open")
		return
	}
	g, err := h.bs.GetGoal(r.Context(), project, id)
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, "could not read the goal")
		}
		return
	}
	team, goal := g.BoardID, strconv.FormatInt(g.ID, 10)
	if team != project { // the goal the store loaded is on the path's board (it asked for that board); the entry's team is the board's own, never the request's text
		errNotFound(w, "no such goal")
		return
	}
	prefix := team + "|" + goal + "|"
	key, max := setreg.GoalDoneHidden, goalDoneHiddenMax
	var edit func([]string) []string
	switch body.State {
	case doneStateNotYet:
		entry := goalDoneKey(team, g.ID, g.Rollup.Total)
		edit = func(l []string) []string { return append(withoutEntry(l, entry), entry) }
	case doneStateDismiss:
		entry := prefix + "*"
		edit = func(l []string) []string { return append(withoutEntry(l, entry), entry) }
	case doneStateShow:
		edit = func(l []string) []string { return withoutPrefix(l, prefix) }
	case doneStateRead:
		key = setreg.GoalDoneRead
		entry := goalDoneReadKey(team, g.ID, g.Rollup.Total, g.UpdatedAt)
		edit = func(l []string) []string { return append(withoutEntry(l, entry), entry) }
	case doneStateUnread:
		key = setreg.GoalDoneRead
		edit = func(l []string) []string { return withoutPrefix(l, prefix) }
	}
	if _, err := h.goalDoneEdit(r.Context(), key, max, edit); err != nil {
		errInternalServer(w, "could not save")
		return
	}
	if body.State == doneStateNotYet || body.State == doneStateDismiss { // the Operator hid a row: what the PUT of goal_done_hidden recorded (#13609, #7512)
		h.recordActivity(r, board.ActInboxHide, "goal", goal, project, g.Title, body.State)
		inboxActioned(r, tracking.InboxGoalDone, "", "hide", time.Time{})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "state": body.State})
}

func withoutEntry(l []string, entry string) []string {
	out := make([]string, 0, len(l)+1)
	for _, e := range l {
		if e != entry {
			out = append(out, e)
		}
	}
	return out
}

// withoutPrefix drops every entry of one goal on one team ("<team>|<goal>|...").
func withoutPrefix(l []string, prefix string) []string {
	out := make([]string, 0, len(l))
	for _, e := range l {
		if !strings.HasPrefix(e, prefix) {
			out = append(out, e)
		}
	}
	return out
}
