package routes

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// ReplyToTask answers a task (#5463, coral-hub's inbox): one ordinary board message linked to the task (message.task_id) whose text starts with a mention of the task's creator,
// so the existing mention delivery notifies them. POST /api/board/{project}/tasks/{taskID}/reply {"content": "..."}
//
// It is the post route with a task: postMessageCore does everything a post does (the 256 KiB cap, cleaning, the new-board rule, the hub user as the sender and the Operator rule,
// stamping, the recorded hub action, waits and notification). The body has no subscriber_id and no as: the sender is whoever the request proves it is, exactly as for a
// post (Coral Hub: the stamped hub user; locally: the verified actor). The task is looked up by the URL's board first, so a task of another board is a 404 before anything is
// written or a board is made. The creator's mention is added only when it tags exactly the creator (board.TaskReplyMention); otherwise the reply is stored with its task_id, nobody
// is notified and the answer carries the warning creator_not_reachable. A reply never changes the task.
func (h *BoardHandler) ReplyToTask(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	taskID, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil || taskID <= 0 {
		errBadRequest(w, "invalid task ID")
		return
	}
	task, err := h.bs.GetTask(r.Context(), project, taskID)
	if err != nil || task == nil {
		errNotFound(w, "Task not found")
		return
	}
	var in struct {
		Content string `json:"content"`
		ReplyTo int64  `json:"reply_to,omitempty"` // the message of the task the words answer (the newest one from someone else), so the board threads them under it (#12502)
	}
	derr := decodeJSON(r, &in)
	if derr == nil && in.ReplyTo != 0 && (in.ReplyTo < 0 || h.bs.CheckReplyTo(r.Context(), project, in.ReplyTo) != nil) {
		errBadRequest(w, "reply_to is not a message of this board") // before anything is posted
		return
	}
	reply := &taskReply{taskID: taskID, creator: task.CreatedBy}
	msg, ok := h.postMessageCore(w, r, project, derr, postMessageBody{Content: in.Content, ReplyTo: in.ReplyTo}, reply)
	if !ok {
		return
	}
	if in.ReplyTo > 0 {
		if err := h.bs.RecordReply(r.Context(), project, msg.ID, in.ReplyTo); err != nil {
			slog.Warn("board reply not recorded", "board", project, "message", msg.ID, "error", err)
		}
	}
	notified := reply.notified
	if notified == nil {
		notified = []string{}
	}
	out := map[string]any{"ok": true, "message_id": msg.ID, "task_id": taskID, "notified": notified}
	if reply.prefix == "" {
		out["warnings"] = []string{"creator_not_reachable"}
	}
	writeJSON(w, http.StatusOK, out)
}
