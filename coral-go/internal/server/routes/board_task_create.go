// Who may plan tasks, and creating a task (moved out of board.go, #4998; no behaviour change).

package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// requireTaskPlanner follows the local board identity model: subscriber_id
// identifies the caller, while privileges come from the active registration
// on this board. Personal task endpoints use a separate store/scope.
func (h *BoardHandler) requireTaskPlanner(w http.ResponseWriter, r *http.Request, project, actor string) bool {
	// Operator is the reserved identity used by the desktop dashboard. Server
	// auth already gates remote requests; local clients share the desktop trust
	// boundary. This is not cryptographic attestation of a human caller.
	// The Operator is the actor the identity layer verified (#4255), in any spelling the caller used;
	// the exact name "Operator" in the claim is the earlier test: kept in log mode, where a claimant with
	// nothing behind the name passes and is counted, and gone under enforce.
	if callerActor(r).IsOperator() {
		return true
	}
	if actor == "Operator" {
		if identityActorEnforced() {
			errForbidden(w, "only the Operator or an active registered orchestrator may create or reassign shared tasks")
			return false
		}
		noteEnforceDiffers("task-planner", r)
		return true
	}
	if err := h.bs.RequireTaskReviewer(r.Context(), project, actor); err != nil {
		errForbidden(w, "only Operator or an active registered orchestrator may create or reassign shared tasks; coordinate with your orchestrator")
		return false
	}
	return true
}

// isTaskPlanner reports whether actor plans this board's tasks: the Operator or an active
// registered orchestrator.
func (h *BoardHandler) isTaskPlanner(ctx context.Context, project, actor string) bool {
	return actor == "Operator" || (actor != "" && h.bs.RequireTaskReviewer(ctx, project, actor) == nil)
}

// requirePlannerOrAssignee answers 400 without an actor, 403 unless actor plans tasks or is
// the task's assignee (#3668, the task handlers' follow-up: cancel, title and priority edits,
// nudges and reminders). It reports whether the request may go on.
func (h *BoardHandler) requirePlannerOrAssignee(w http.ResponseWriter, ctx context.Context, project string, task *board.Task, actor, what string) bool {
	if actor == "" {
		errBadRequest(w, "subscriber_id required")
		return false
	}
	if h.isTaskPlanner(ctx, project, actor) || (task.AssignedTo != nil && *task.AssignedTo == actor) {
		return true
	}
	errForbidden(w, "only the task's assignee, Operator or an active registered orchestrator may "+what)
	return false
}

// taskActor is who acts on a task: the JSON body's subscriber_id if the handler read one, else
// the query's (a DELETE, or the dashboard's nudge, carries no body). The identity layer binds
// both to the caller's token.
func taskActor(r *http.Request, fromBody string) string {
	if a := strings.TrimSpace(fromBody); a != "" {
		return a
	}
	return strings.TrimSpace(r.URL.Query().Get("subscriber_id"))
}

// CreateTask creates a new task on a board.
// POST /api/board/{project}/tasks
func (h *BoardHandler) CreateTask(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	var body struct {
		Title          string             `json:"title"`
		Body           string             `json:"body"`
		Priority       string             `json:"priority"`
		CreatedBy      string             `json:"created_by"`
		SubscriberID   string             `json:"subscriber_id"`
		AssignedTo     string             `json:"assigned_to"`
		BlockedBy      json.RawMessage    `json:"blocked_by,omitempty"`
		Draft          bool               `json:"draft,omitempty"`
		Workflow       board.TaskWorkflow `json:"workflow,omitempty"`
		RemindAt       string             `json:"remind_at,omitempty"`        // RFC 3339: a one-time reminder (#4175 step 3)
		GoalID         *int64             `json:"goal_id,omitempty"`          // a goal of this board the task works toward (#7087)
		GoalProposalID *int64             `json:"goal_proposal_id,omitempty"` // the pending goal proposal this task is for: it waits for that goal (#11389)
		Self           bool               `json:"self,omitempty"`             // a task the caller makes for ITSELF (#11247): any member may, with a goal, one per title, at most maxOpenSelfTasks open
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	if body.Title == "" {
		errBadRequest(w, "title required")
		return
	}
	if refuseTextTooLarge(w, "title_too_large", "a task title", len(body.Title), maxTaskTitleBytes) ||
		refuseTextTooLarge(w, "body_too_large", "a task body", len(body.Body), maxTaskBodyBytes) {
		return
	}
	var remindAt time.Time
	if body.RemindAt != "" {
		at, err := time.Parse(time.RFC3339, body.RemindAt)
		if now := time.Now(); err != nil || !at.After(now) || at.After(now.AddDate(0, 0, maxParkDays)) {
			errBadRequest(w, fmt.Sprintf("remind_at: an RFC 3339 time in the next %d days", maxParkDays))
			return
		}
		remindAt = at
	}
	if h.refuseShortArtifactRefs(w, r, &body.Title) || h.refuseShortArtifactRefs(w, r, &body.Body) { // shortened artifact links are made whole, or the task is refused (#9841)
		return
	}
	if refuseNewBoardName(w, r, h.bs, project) {
		return
	}
	attrClaim := body.SubscriberID
	if attrClaim == "" {
		attrClaim = body.CreatedBy
	}
	attrWho, attrOK := attributedTo(w, r, attrClaim)
	if !attrOK {
		return
	}
	if identityActorEnforced() { // the attributed name is the creator, whichever alias was used
		body.SubscriberID, body.CreatedBy = attrWho, attrWho
	}
	createdBy := body.CreatedBy
	if createdBy == "" {
		createdBy = body.SubscriberID
	}
	if createdBy == "" {
		errBadRequest(w, "created_by or subscriber_id required")
		return
	}
	// subscriber_id is the request actor; created_by remains a legacy alias.
	// Never let an attribution field override an explicitly supplied actor.
	if body.SubscriberID != "" && createdBy != body.SubscriberID {
		errForbidden(w, "created_by must match subscriber_id")
		return
	}
	if body.Self {
		// A task for the caller alone (#11247, QA's #11216): an agent opens its own work, e.g. the release's "UI review", without an orchestrator. It assigns nothing to anyone else, so the shared-task
		// rule does not apply; what it must not become is a way to post work for others or to flood the queue: the assignee is the creator, a goal is required, a repeat of an open title returns that
		// task, and at most maxOpenSelfTasks are open at once.
		if existing, done := h.selfTaskChecks(w, r, project, createdBy, &body.Title, &body.AssignedTo, body.GoalID); done {
			if existing != nil {
				writeExistingTask(w, existing)
			}
			return
		}
		h.selfTaskMu.Lock()
		defer h.selfTaskMu.Unlock() // the one-per-title check and the creation are one step
		if existing, done := h.selfTaskLimits(w, r, project, createdBy, body.Title); done {
			if existing != nil {
				writeExistingTask(w, existing)
			}
			return
		}
	} else if !h.requireTaskPlanner(w, r, project, createdBy) {
		return
	}
	// An agent token may have at most maxOpenTasksPerAgent open tasks it created on a board (#4602, M10); the Operator and
	// Coral's own tasks are not counted.
	if callerActor(r).Kind == ActorToken {
		open, err := h.bs.CountOpenTasksCreatedBy(r.Context(), project, createdBy)
		if err != nil {
			errInternalServer(w, err.Error())
			return
		}
		if open >= maxOpenTasksPerAgent {
			msg := fmt.Sprintf("an agent can have at most %d open tasks it created on a board (it has %d): complete or cancel some first", maxOpenTasksPerAgent, open)
			writeJSON(w, http.StatusConflict, map[string]any{"error": msg, "message": msg, "code": "too_many_open_tasks", "max": maxOpenTasksPerAgent, "not_saved": true})
			return
		}
	}
	if body.Priority == "" {
		body.Priority = "medium"
	}

	// How the creator's name is backed: the server's to say, whatever the request sent (#4175).
	clearReviewFields(&body.Workflow)
	body.Workflow.CreatedIdentity = h.claimIdentity(r, project, createdBy)
	body.Workflow.AmendIdentity = nil
	opts := &board.CreateTaskOpts{Draft: body.Draft, Workflow: body.Workflow, GoalID: body.GoalID}
	if len(body.BlockedBy) > 0 {
		deps, err := parseBlockedBy(body.BlockedBy, project)
		if err != nil {
			errBadRequest(w, err.Error())
			return
		}
		opts.BlockedBy, opts.MaxDepth = deps, 32
	}

	if h.refuseArchivedAssignee(w, r.Context(), project, body.AssignedTo) {
		return
	}
	if hold, ok := h.needsApproval(r, project, board.ProposalTask); !ok {
		errInternalServer(w, "could not read the board's settings")
		return
	} else if (hold && !body.Self) || body.GoalProposalID != nil { // this team's tasks need the Operator's approval (#11389), and a task for a goal still waiting waits with it; an agent's own self task is exempt
		if body.GoalProposalID != nil {
			if gp, err := h.bs.GetProposal(r.Context(), project, *body.GoalProposalID); err != nil || gp.Kind != board.ProposalGoal || gp.State != board.ProposalPending {
				errNotFound(w, "goal_proposal_id is a goal of this team that is waiting for approval")
				return
			}
		}
		payload, _ := json.Marshal(taskPayload{Title: body.Title, Body: body.Body, Priority: body.Priority, CreatedBy: createdBy, AssignedTo: body.AssignedTo, Draft: body.Draft, Workflow: body.Workflow, GoalID: body.GoalID, BlockedBy: body.BlockedBy, RemindAt: body.RemindAt})
		h.proposeAnswer(w, r, board.ProposalInput{Board: project, Kind: board.ProposalTask, Title: body.Title, Payload: payload, Proposer: createdBy, GoalProposalID: body.GoalProposalID})
		return
	}
	task, err := h.makeTask(r.Context(), project, taskCreation{Title: body.Title, Body: body.Body, Priority: body.Priority, CreatedBy: createdBy, AssignedTo: body.AssignedTo, Opts: opts, RemindAt: remindAt})
	if err != nil {
		if task == nil {
			if !goalError(w, err) {
				errBadRequest(w, err.Error())
			}
			return
		}
		errInternalServer(w, err.Error()) // the task was made, its reminder was not
		return
	}
	writeJSON(w, http.StatusCreated, task)
}

// announceCreatedTask tells the board (and nudges an agent) about a task that was just created: a draft or blocked one on the queue line, a published one with its assignment.
func (h *BoardHandler) announceCreatedTask(project string, task *board.Task) {
	assignee := ""
	if task.AssignedTo != nil {
		assignee = *task.AssignedTo
	}
	if task.Status == "draft" {
		h.goBG(func() {
			notification := fmt.Sprintf("[Task #%d (draft)] %s", task.ID, h.noticeText(context.Background(), project, task.Title))
			h.postNotice(context.Background(), project, notification)
		})
	} else if task.Status == "blocked" {
		h.goBG(func() {
			deps, _ := h.bs.GetTaskDependencies(context.Background(), task.ID)
			blockerList := formatBlockerList(deps)
			notification := fmt.Sprintf("[Task #%d (blocked)] %s — blocked by %s", task.ID, h.noticeText(context.Background(), project, task.Title), h.noticeText(context.Background(), project, blockerList))
			h.postNotice(context.Background(), project, notification)
		})
	} else {
		h.goBG(func() {
			ctx := context.Background()
			notification := h.buildAssignmentNotification(ctx, project, task, assignee, false)
			h.postNotice(ctx, project, notification)

			// Send direct terminal nudge
			if h.terminal != nil {
				if assignee != "" {
					hasActive, _ := h.bs.HasActiveTaskForAssignee(ctx, project, assignee, task.ID)
					if !hasActive {
						h.sendTaskNudge(ctx, project, assignee, taskClaimNudge(task.ID))
					}
				} else {
					idle := h.bs.FindIdleSubscriber(ctx, project, func(sub *board.Subscriber) bool {
						return h.isArchivedSession != nil && h.isArchivedSession(ctx, sub.SessionName)
					})
					if idle != nil && idle.SessionName != "" {
						if err := h.sendAutomated(ctx, project, idle.SessionName, taskNudge); err != nil {
							slog.Warn("failed to nudge agent", "subscriber", idle.SubscriberID, "session", idle.SessionName, "error", err)
						}
					}
				}
			}
		})
	}
}

// parseBlockedBy handles both shorthand [1, 2, 3] and full [{task_id: 1, board_id: "x"}] formats.
func parseBlockedBy(raw json.RawMessage, defaultBoard string) ([]board.TaskDep, error) {
	// Try shorthand: array of integers
	var ids []int64
	if err := json.Unmarshal(raw, &ids); err == nil {
		deps := make([]board.TaskDep, len(ids))
		for i, id := range ids {
			deps[i] = board.TaskDep{TaskID: id, BoardID: defaultBoard}
		}
		return deps, nil
	}
	// Try full format: array of TaskDep objects
	var deps []board.TaskDep
	if err := json.Unmarshal(raw, &deps); err != nil {
		return nil, fmt.Errorf("invalid blocked_by format")
	}
	for i := range deps {
		if deps[i].BoardID == "" {
			deps[i].BoardID = defaultBoard
		}
	}
	return deps, nil
}

func formatBlockerList(deps []board.TaskDep) string {
	if len(deps) == 0 {
		return "unknown"
	}
	parts := make([]string, len(deps))
	for i, d := range deps {
		parts[i] = fmt.Sprintf("#%d", d.TaskID)
		if d.BlockedReason != "" {
			parts[i] += " (" + d.BlockedReason + ")"
		}
	}
	return strings.Join(parts, ", ")
}

// The sizes of the text a task and a wait may carry (#4602, M10): a task's title is typed into its assignee's terminal and
// its body is read by every agent that opens it, so neither is allowed to be a document. A larger one is a 413 that says
// so; nothing is stored.
const (
	maxTaskTitleBytes  = 512
	maxTaskBodyBytes   = 256 << 10
	maxWaitReasonBytes = 4 << 10
	// maxOpenTasksPerAgent is how many open tasks one agent token may have created on a board.
	maxOpenTasksPerAgent = 500
)

// refuseTextTooLarge answers 413 with code, and reports true, when got is over max bytes. what names the text ("a task title").
func refuseTextTooLarge(w http.ResponseWriter, code, what string, got, max int) bool {
	if got <= max {
		return false
	}
	msg := fmt.Sprintf("%s is at most %d bytes (this one is %d): shorten it; long text belongs in an artifact (coral-agent artifact upload) with its link in the text", what, max, got)
	writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": msg, "message": msg, "code": code, "max_bytes": max, "not_saved": true})
	return true
}

// maxFullTaskRows caps GET /api/board/{project}/tasks?full=1, and maxAllTasksRows the plain GET /api/board/tasks (#4602).
const (
	// maxBoardPostContent is the longest board post (#4602).
	maxBoardPostContent = 256 << 10
	maxFullTaskRows     = 500
	maxAllTasksRows     = 500
)

// clearReviewFields removes what only Coral writes when a review is made or pooled from a task a client creates (#8957): a build task that
// says review_of is a review to the Reviews only filter, and one that says review_in_pool is in the pool. Coral's own review tasks are made by
// the store, not through this route.
func clearReviewFields(wf *board.TaskWorkflow) {
	wf.ReviewOf, wf.ReviewRound, wf.ReviewRounds, wf.OriginalAuthor = 0, 0, nil, ""
	wf.ReviewInPool, wf.ReviewAreas, wf.ReviewersWanted, wf.ReviewPooledAt = false, nil, 0, ""
}

// maxOpenSelfTasks is how many open tasks one agent may have made for itself on a board.
const maxOpenSelfTasks = 5

// selfTaskChecks is what a self task must be before anything is created: a member of this board making it for itself, with a goal. done is true when the request was answered (a refusal).
func (h *BoardHandler) selfTaskChecks(w http.ResponseWriter, r *http.Request, project, createdBy string, title, assignedTo *string, goalID *int64) (*board.Task, bool) {
	if a := strings.TrimSpace(*assignedTo); a != "" && !board.SameIdentity(a, createdBy) {
		errForbidden(w, "a self task is assigned to its creator only: leave out the assignee, or ask the orchestrator for a task for someone else")
		return nil, true
	}
	if goalID == nil || *goalID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "a self task needs a goal (--goal N): say what it serves", "code": "goal_required", "not_saved": true})
		return nil, true
	}
	if board.IsOperatorName(createdBy) {
		*assignedTo = createdBy
		return nil, false // the Operator plans anything; --self for it is the same task, assigned to itself
	}
	if sub, err := h.bs.GetProjectSubscription(r.Context(), project, createdBy); err != nil || sub == nil {
		errForbidden(w, "only a member of this board may make a task for itself")
		return nil, true
	}
	*title = strings.TrimSpace(*title)
	*assignedTo = createdBy
	return nil, false
}

// selfTaskLimits is the one-per-title rule and the cap of open self tasks: a repeat of an open title returns that task (existing, done), and past the cap the request is refused (done).
func (h *BoardHandler) selfTaskLimits(w http.ResponseWriter, r *http.Request, project, createdBy, title string) (*board.Task, bool) {
	open, err := h.bs.OpenSelfTasks(r.Context(), project, createdBy)
	if err != nil {
		errInternalServer(w, err.Error())
		return nil, true
	}
	for _, t := range open {
		if strings.EqualFold(strings.TrimSpace(t.Title), strings.TrimSpace(title)) {
			task, err := h.bs.GetTask(r.Context(), project, t.ID)
			if err != nil || task == nil {
				errInternalServer(w, "the existing task could not be read")
				return nil, true
			}
			return task, true
		}
	}
	if len(open) >= maxOpenSelfTasks {
		msg := fmt.Sprintf("an agent can have at most %d open tasks it made for itself on a board (it has %d): complete or cancel some first", maxOpenSelfTasks, len(open))
		writeJSON(w, http.StatusConflict, map[string]any{"error": msg, "message": msg, "code": "too_many_self_tasks", "max": maxOpenSelfTasks, "not_saved": true})
		return nil, true
	}
	return nil, false
}

// writeExistingTask answers a self task whose title is already open: 200 and that task, marked existing so a caller can tell it from one just created.
func writeExistingTask(w http.ResponseWriter, task *board.Task) {
	raw, err := json.Marshal(task)
	var out map[string]any
	if err != nil || json.Unmarshal(raw, &out) != nil {
		errInternalServer(w, "the existing task could not be read")
		return
	}
	out["existing"] = true
	writeJSON(w, http.StatusOK, out)
}
