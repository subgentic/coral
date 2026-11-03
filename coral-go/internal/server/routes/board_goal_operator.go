package routes

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// The Operator's two changes to a goal that an orchestrator may not make (#12693): who drives it, and which team it belongs to. Person only: an agent token, a key and a Hub grantee get 403, and through the Hub only the
// account this computer is linked to (refuseNonOwner), as for the buttons on a question.

func operatorGoalCaller(w http.ResponseWriter, r *http.Request, what string) bool {
	if refuseNonOwner(w, r) {
		return false
	}
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "owner_only", "only the person at this computer can "+what)
		return false
	}
	return true
}

// SetGoalDriver: POST /api/board/{project}/goals/{goalID}/driver {"driver": "<a member of the goal's team>"}. An empty driver clears it. The new driver is told as when a goal is given to them.
func (h *BoardHandler) SetGoalDriver(w http.ResponseWriter, r *http.Request) {
	if !operatorGoalCaller(w, r, "change who drives a goal") {
		return
	}
	project := urlParam(r, "project")
	id, ok := goalID(w, r)
	if !ok {
		return
	}
	var body struct {
		Driver *string `json:"driver"`
	}
	if err := decodeJSONStrict(r, &body); err != nil || body.Driver == nil {
		errBadRequest(w, `send {"driver": "<a member of the team>"} ("" for none)`)
		return
	}
	cur, err := h.bs.GetGoal(r.Context(), project, id)
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, "could not read the goal")
		}
		return
	}
	g, err := h.bs.UpdateGoal(r.Context(), project, id, board.GoalUpdate{Driver: body.Driver})
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	h.announceGoalDriver(project, "Operator", g, cur.Driver)
	h.markMadeByOrchestrator(r.Context(), project, g)
	writeJSON(w, http.StatusOK, g)
}

// MoveGoal: POST /api/board/{project}/goals/{goalID}/move {"to_project": "<another team's board>", "driver": "<a member of that team, optional>"}. The goal is copied to the other team (the same title, outcome and
// done-when, its pictures, the same state; the driver the Operator names, else none: that team's orchestrator is told) and the old goal is closed as dropped with "moved to <team> as goal #N". Its tasks STAY on
// this team, unchanged, and so do its comments: nothing is re-keyed, so nothing is half moved. Each team's board gets one line that says so.
func (h *BoardHandler) MoveGoal(w http.ResponseWriter, r *http.Request) {
	if !operatorGoalCaller(w, r, "move a goal to another team") {
		return
	}
	project := urlParam(r, "project")
	id, ok := goalID(w, r)
	if !ok {
		return
	}
	var body struct {
		ToProject string `json:"to_project"`
		Driver    string `json:"driver"`
	}
	if err := decodeJSONStrict(r, &body); err != nil || strings.TrimSpace(body.ToProject) == "" {
		errBadRequest(w, `send {"to_project": "<the other team's board>", "driver": "<a member of it, optional>"}`)
		return
	}
	to := strings.TrimSpace(body.ToProject)
	if to == project {
		errBadRequest(w, "that goal is already on this team")
		return
	}
	ctx := r.Context()
	if _, err := h.bs.GetBoard(ctx, to); err != nil {
		if errors.Is(err, board.ErrBoardNotFound) {
			errNotFound(w, "no such team")
		} else {
			errInternalServer(w, "could not read the team")
		}
		return
	}
	old, err := h.bs.GetGoal(ctx, project, id)
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, "could not read the goal")
		}
		return
	}
	if old.Closed() {
		writeError(w, http.StatusConflict, "goal_closed", "a closed goal is not moved: open it again first")
		return
	}
	state := board.GoalActive
	if old.State == board.GoalProposed {
		state = board.GoalProposed
	}
	fresh, err := h.bs.CreateGoal(ctx, to, board.GoalInput{Title: old.Title, Outcome: old.Outcome, DoneWhen: old.DoneWhen, State: state, CreatedBy: "Operator", Driver: strings.TrimSpace(body.Driver)})
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	if len(old.Images) > 0 {
		if err := h.bs.SetGoalImages(ctx, to, fresh.ID, old.Images); err != nil {
			h.logGoalMove("pictures not copied", project, to, id, fresh.ID, err)
		}
	}
	toLabel := h.bs.BoardLabel(ctx, to)
	closed, open, err := h.bs.CloseGoal(ctx, project, id, fmt.Sprintf("moved to %s as goal #%d", noticeLabel(toLabel), fresh.ID), board.GoalDropped)
	if err != nil {
		h.logGoalMove("the old goal could not be closed", project, to, id, fresh.ID, err)
		writeError(w, http.StatusInternalServerError, "close_failed", fmt.Sprintf("the goal was copied to the other team as goal #%d, but this one could not be closed: close it by hand", fresh.ID))
		return
	}
	h.announceMove(ctx, project, to, old, fresh, open)
	h.announceGoalToOrchestrator(to, "Operator", fresh)
	h.announceGoalDriver(to, "Operator", fresh, "")
	h.markMadeByOrchestrator(ctx, to, fresh)
	writeJSON(w, http.StatusOK, map[string]any{"goal": fresh, "old": closed, "open_tasks_staying": open, "to_project": to})
}

// noticeLabel is a team's label as one plain word for a reason line.
func noticeLabel(s string) string { return strings.Join(strings.Fields(s), " ") }

func (h *BoardHandler) logGoalMove(what, from, to string, oldID, newID int64, err error) {
	slog.Warn("goal move: "+what, "from", from, "to", to, "old_goal", oldID, "new_goal", newID, "error", err)
}

// announceMove puts one line on each team's board, as the Operator's goal lines are: what moved, where, and that the tasks stayed.
func (h *BoardHandler) announceMove(ctx context.Context, from, to string, old, fresh *board.Goal, open int) {
	fromLabel, toLabel := h.noticeText(ctx, from, h.bs.BoardLabel(ctx, from)), h.noticeText(ctx, to, h.bs.BoardLabel(ctx, to))
	title := h.noticeText(ctx, to, fresh.Title)
	tasks := "No open task of it stays here."
	if open > 0 {
		tasks = fmt.Sprintf("Its %d open task(s) stay here, unchanged.", open)
	}
	h.postNotice(ctx, from, fmt.Sprintf("[Goal #%d] moved to team %s as goal #%s: %s. %s", old.ID, quoteNotice(toLabel), strconv.FormatInt(fresh.ID, 10), quoteNotice(title), tasks))
	h.postNotice(ctx, to, fmt.Sprintf("[Goal #%d] moved here from team %s (it was goal #%d there): %s. Its tasks stay on that team.", fresh.ID, quoteNotice(fromLabel), old.ID, quoteNotice(title)))
}
