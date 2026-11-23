package routes

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// Pictures on a personal task (#20800, goal #285): images {"body": [hex]} on the create and the edit of a task on an agent's own list, the Operator's alone, uploaded with POST /api/field-images?scope=instruction
// (a personal list has no team). A personal task is a row of the board tasks under the project its agent and session name, so its pictures are kept as a board task's are, under that project: a claim shows them.

func taskPicturesProject(name string, sid *string) string { return store.AgentTaskProject(name, sid) }

// taskPictures checks the images of a personal task write; it answers the request when one is not allowed. taskID is 0 for a task being created.
func (h *SessionsHandler) taskPictures(w http.ResponseWriter, r *http.Request, project string, taskID int64, draft string, in map[string][]string) (map[string][]board.GoalImage, bool) {
	if in == nil {
		return nil, true
	}
	if h.boardHandler == nil || h.boardHandler.bs == nil {
		writeError(w, http.StatusServiceUnavailable, "pictures_unavailable", "pictures are not available here")
		return nil, false
	}
	var record map[string][]board.GoalImage
	if taskID != 0 {
		record = h.boardHandler.recordedFieldImages(r, project, board.FieldImagesTask, board.TaskFieldImagesOwner(taskID))
	}
	return h.boardHandler.fieldPictures(w, r, "", "instruction", draft, in, record, "body")
}

// keepTaskPictures saves what a write named; false when the save failed (the task is written: the answer says its pictures are not saved, #20758).
func (h *SessionsHandler) keepTaskPictures(ctx context.Context, project string, taskID int64, pictures map[string][]board.GoalImage) bool {
	if len(pictures) == 0 || h.boardHandler == nil || h.boardHandler.bs == nil {
		return true
	}
	if err := h.boardHandler.saveFieldImages(ctx, project, board.FieldImagesTask, board.TaskFieldImagesOwner(taskID), pictures); err != nil {
		slog.Warn("[sessions] the pictures of a personal task were not kept", "task", taskID, "error", err)
		return false
	}
	return true
}

func (h *SessionsHandler) taskImages(ctx context.Context, project string, taskID int64) map[string][]board.GoalImage {
	if h.boardHandler == nil || h.boardHandler.bs == nil {
		return nil
	}
	m, _ := h.boardHandler.bs.FieldImages(ctx, project, board.FieldImagesTask, board.TaskFieldImagesOwner(taskID))
	return m
}

// withTaskImages puts each task's pictures on it, one read for each personal list.
func (h *SessionsHandler) withTaskImages(ctx context.Context, tasks []store.AgentTask) {
	if h.boardHandler == nil || h.boardHandler.bs == nil || len(tasks) == 0 {
		return
	}
	byProject := map[string]map[string]map[string][]board.GoalImage{}
	for i := range tasks {
		project := taskPicturesProject(tasks[i].AgentName, tasks[i].SessionID)
		all, seen := byProject[project]
		if !seen {
			all, _ = h.boardHandler.bs.FieldImagesOfBoard(ctx, project, board.FieldImagesTask)
			byProject[project] = all
		}
		if m := all[strconv.FormatInt(tasks[i].ID, 10)]; len(m) > 0 {
			tasks[i].Images = m
		}
	}
}

// forgetTaskPictures removes the pictures of a task that is deleted; the artifacts stay, other records may share them.
func (h *SessionsHandler) forgetTaskPictures(ctx context.Context, project string, taskID int64) {
	if h.boardHandler == nil || h.boardHandler.bs == nil {
		return
	}
	if err := h.boardHandler.bs.DeleteFieldImages(ctx, project, board.FieldImagesTask, board.TaskFieldImagesOwner(taskID)); err != nil {
		slog.Warn("[sessions] the pictures of a deleted personal task were not removed", "task", taskID, "error", err)
	}
}
