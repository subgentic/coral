package routes

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// An artifact an agent uploads is linked to the task it is working on (#7739, the operator's: "any artifact created by an agent working on a task links to that task"). The task is the
// member's one in-progress task on its board; a member works on one task at a time, so two in progress is a store that should not exist: it is logged and the upload is linked to none. A person's
// upload (the dashboard) has no agent and is never linked. The link is kept on the upload's own record (agentUploadRecord.TaskID), never on the object, which every upload of the same bytes shares.

// taskHeader names the upload's task: a task number (it must be one assigned to the uploader on its own board: another member's task, another board's, and a task that is not there are all the
// same refusal), or "none" for an upload that is not linked.
const taskHeader = "X-Artifact-Task"

// taskLinkNone is storeArtifactFile's taskID for "link nothing, and drop a link this upload's record had": an upload sent with --no-task.
const taskLinkNone int64 = -1

// artifactTaskLink is the task number an upload by the verified session in ctx links to: 0 for none, taskLinkNone for an explicit "none". refused says why an explicitly named task cannot be
// used (nothing is stored then); an upload that names none and has no one task in progress is simply not linked.
func (h *SessionsHandler) artifactTaskLink(ctx context.Context, r *http.Request) (taskID int64, refused string) {
	named := strings.TrimSpace(r.Header.Get(taskHeader))
	if strings.EqualFold(named, "none") {
		return taskLinkNone, ""
	}
	owner, ok := VerifiedSession(ctx)
	if !ok || owner == nil || h.bs == nil {
		if named != "" {
			return 0, "a task can only be named by an agent that is on the task's board"
		}
		return 0, ""
	}
	sub, err := h.bs.GetSubscriptionBySessionName(ctx, owner.SessionName)
	if err != nil || sub == nil {
		if named != "" {
			return 0, "a task can only be named by an agent that is on the task's board"
		}
		return 0, ""
	}
	if named != "" {
		id, perr := strconv.ParseInt(named, 10, 64)
		if perr != nil || id <= 0 {
			return 0, "X-Artifact-Task must be a task number, or none"
		}
		task, terr := h.bs.GetTask(ctx, sub.Project, id)
		if terr != nil || task == nil || task.AssignedTo == nil || *task.AssignedTo != sub.SubscriberID {
			return 0, "that task is not one of yours on this board"
		}
		return id, ""
	}
	ids, err := h.bs.InProgressTaskIDsOf(ctx, sub.Project, sub.SubscriberID)
	if err != nil {
		return 0, ""
	}
	if len(ids) > 1 {
		slog.Warn("[artifacts] a member has more than one task in progress: the upload is linked to none", "board", sub.Project, "member", sub.SubscriberID, "tasks", ids)
		return 0, ""
	}
	if len(ids) == 1 {
		return ids[0], ""
	}
	return 0, ""
}
