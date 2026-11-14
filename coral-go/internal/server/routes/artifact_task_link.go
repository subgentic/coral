package routes

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
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
func (h *SessionsHandler) artifactTaskLink(ctx context.Context, r *http.Request) (taskID int64, refused, note string) {
	named := strings.TrimSpace(r.Header.Get(taskHeader))
	if strings.EqualFold(named, "none") {
		return taskLinkNone, "", ""
	}
	owner, ok := VerifiedSession(ctx)
	if !ok || owner == nil || h.bs == nil {
		if named != "" {
			return 0, "a task can only be named by an agent that is on the task's board", ""
		}
		return 0, "", ""
	}
	sub, err := h.bs.GetSubscriptionBySessionName(ctx, owner.SessionName)
	if err != nil || sub == nil {
		if named != "" {
			return 0, "a task can only be named by an agent that is on the task's board", ""
		}
		return 0, "", ""
	}
	if named != "" {
		id, perr := strconv.ParseInt(named, 10, 64)
		if perr != nil || id <= 0 {
			return 0, "X-Artifact-Task must be a task number, or none", ""
		}
		task, terr := h.bs.GetTask(ctx, sub.Project, id)
		// Mine: assigned to me, or in review and mine to begin with (#16139). A task handed in for review is assigned to the orchestrator and keeps its author in the workflow: the author's
		// screenshots, asked for during the review, are theirs to add (they used to be refused, and the upload fell onto whatever else the author had open).
		mine := terr == nil && task != nil && task.AssignedTo != nil && *task.AssignedTo == sub.SubscriberID
		if !mine && terr == nil && task != nil && task.Status == "review_pending" && task.Workflow.OriginalAuthor != "" && board.SameIdentity(task.Workflow.OriginalAuthor, sub.SubscriberID) {
			mine = true
		}
		if !mine {
			// One answer for another member's task, another board's and a missing one, so it does not say which exist; it names the fix, and nothing is stored or linked to any other task (#16139).
			return 0, "that task is not one of yours on this board: name a task assigned to you, or one you submitted for review (--task N), or upload with --no-task. Nothing was uploaded and it was not linked to any other task", ""
		}
		switch task.Status { // a finished task takes no more files: said now, never an upload that links to a task that is closed and vanishes from its page (#12755)
		case "completed", "skipped":
			return 0, "task " + strconv.FormatInt(id, 10) + " is " + task.Status + ": it takes no more files. Upload with --no-task, or to a task that is open", ""
		}
		return id, "", ""
	}
	ids, err := h.bs.OpenTaskIDsOf(ctx, sub.Project, sub.SubscriberID) // in progress OR in review: evidence is added after a submit (#12755)
	if err != nil {
		return 0, "", ""
	}
	if len(ids) > 1 {
		slog.Warn("[artifacts] a member has more than one open task: the upload is linked to none", "board", sub.Project, "member", sub.SubscriberID, "tasks", ids)
		return 0, "", "you have more than one open task, so this upload is linked to none: name the task with --task N" // said in the reply, never a silent miss
	}
	if len(ids) == 1 {
		return ids[0], "", ""
	}
	return 0, "", ""
}

// noteOffBooksUpload: an agent's upload that links to no task and was not sent with --no-task, from an agent with no task in progress, is work done off the books (#7793, goal #21): the
// orchestrator's health check says it once, when the team's health check and its upload switch are on. A person's upload, a token-less one and the orchestrator's own are not noted.
func (h *SessionsHandler) noteOffBooksUpload(ctx context.Context, taskID int64, digest string) {
	if taskID != 0 || h.bs == nil {
		return
	}
	owner, ok := VerifiedSession(ctx)
	if !ok || owner == nil {
		return
	}
	sub, err := h.bs.GetSubscriptionBySessionName(ctx, owner.SessionName)
	if err != nil || sub == nil {
		return
	}
	hs := h.bs.GetHealthSettings(ctx, sub.Project)
	if !hs.On || !hs.UploadNoTask.On {
		return
	}
	if orch, err := h.bs.TeamOrchestrator(ctx, sub.Project); err == nil && board.SameIdentity(sub.SubscriberID, orch) {
		return
	}
	if ids, err := h.bs.OpenTaskIDsOf(ctx, sub.Project, sub.SubscriberID); err != nil || len(ids) > 0 {
		return // two in progress links none, but it has work: not off the books
	}
	short := digest
	if len(short) > 8 {
		short = short[:8]
	}
	_ = h.bs.AddOffBooks(ctx, sub.Project, board.OffBooksUpload, sub.SubscriberID, digest, "uploaded an artifact ("+short+") with no task in progress", time.Now())
}

// linkedTaskTitle is the title of task id on the board of the verified agent in ctx, "" when it cannot be read: the upload's reply names the task it landed on, so a wrong target is seen at once (#16139).
func (h *SessionsHandler) linkedTaskTitle(ctx context.Context, id int64) string {
	owner, ok := VerifiedSession(ctx)
	if !ok || owner == nil || h.bs == nil || id <= 0 {
		return ""
	}
	sub, err := h.bs.GetSubscriptionBySessionName(ctx, owner.SessionName)
	if err != nil || sub == nil {
		return ""
	}
	titles, err := h.bs.TaskTitles(ctx, sub.Project, []int64{id})
	if err != nil {
		return ""
	}
	return titles[id]
}
