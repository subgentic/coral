package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
)

// The workers a team approves (mock v3 idea 2, #21467). The Operator saves them on the team's page (the dashboard, never an agent); the Orchestrator launches one for a task with
// 'coral-board worker launch "NAME" --task N'. The launch goes through the one launch route (Launch) with the saved setup as its request, so every rule of an agent's launch holds for it:
// the cap on what the new agent may do without asking, the team's agent limit and log, the folder rule, the unique name. A worker adds nothing an agent could not already ask for, except the
// instructions the Operator wrote; what the caller supplies is the task, nothing else.

const maxWorkerBody = 64 << 10

// maxWorkerTaskText is how much of a task's title and body a worker is given as its first message.
const maxWorkerTaskText = 6000

// workerView is a worker as the page and the command line read it.
type workerView struct {
	board.Worker
	RunsAs string `json:"runs_as"`
	Cached bool   `json:"cached"`
}

func viewOfWorkers(ws []board.Worker) []workerView {
	out := make([]workerView, 0, len(ws))
	for _, w := range ws {
		out = append(out, workerView{Worker: w, RunsAs: board.WorkerRuns(w), Cached: board.WorkerCached(w)})
	}
	return out
}

// Workers answers GET /api/board/{project}/workers (any caller of the team: the list is what the Orchestrator is told) and POST (the Operator adds one).
func (h *BoardHandler) Workers(w http.ResponseWriter, r *http.Request) {
	project := chi.URLParam(r, "project")
	if r.Method == http.MethodGet {
		list, err := h.bs.ListWorkers(r.Context(), project)
		if err != nil {
			errInternalServer(w, "could not read the team's workers")
			return
		}
		launched, _ := h.bs.WorkerLaunches(r.Context(), project)
		writeJSON(w, http.StatusOK, map[string]any{"workers": viewOfWorkers(list), "brief": board.WorkersBrief(list), "launched": launched, "max": board.MaxWorkersPerTeam})
		return
	}
	if refuseNonOwner(w, r) || !operatorWrites(w, r, "change the workers a team approves") {
		return
	}
	var in board.Worker
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkerBody)
	if err := decodeJSONStrict(r, &in); err != nil {
		errBadRequest(w, "send the worker's setup as JSON")
		return
	}
	saved, err := h.bs.SaveWorker(r.Context(), project, "", in, false)
	if h.workerWriteFailed(w, err) {
		return
	}
	h.tellOrchestratorWorkersChanged(r.Context(), project)
	writeJSON(w, http.StatusOK, workerView{Worker: *saved, RunsAs: board.WorkerRuns(*saved), Cached: board.WorkerCached(*saved)})
}

// Worker answers PUT and DELETE /api/board/{project}/workers/{name}: the Operator replaces or removes one.
func (h *BoardHandler) Worker(w http.ResponseWriter, r *http.Request) {
	project, name := chi.URLParam(r, "project"), chi.URLParam(r, "name")
	if r.Method == http.MethodGet {
		got, err := h.bs.GetWorker(r.Context(), project, name)
		if errors.Is(err, board.ErrWorkerNotFound) {
			errNotFound(w, "this team has no worker called "+clitext.Clean(name))
			return
		}
		if err != nil {
			errInternalServer(w, "could not read the worker")
			return
		}
		writeJSON(w, http.StatusOK, workerView{Worker: *got, RunsAs: board.WorkerRuns(*got), Cached: board.WorkerCached(*got)})
		return
	}
	if refuseNonOwner(w, r) || !operatorWrites(w, r, "change the workers a team approves") {
		return
	}
	if r.Method == http.MethodDelete {
		if h.workerWriteFailed(w, h.bs.DeleteWorker(r.Context(), project, name)) {
			return
		}
		h.tellOrchestratorWorkersChanged(r.Context(), project)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	var in board.Worker
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkerBody)
	if err := decodeJSONStrict(r, &in); err != nil {
		errBadRequest(w, "send the worker's setup as JSON")
		return
	}
	saved, err := h.bs.SaveWorker(r.Context(), project, name, in, true)
	if h.workerWriteFailed(w, err) {
		return
	}
	h.tellOrchestratorWorkersChanged(r.Context(), project)
	writeJSON(w, http.StatusOK, workerView{Worker: *saved, RunsAs: board.WorkerRuns(*saved), Cached: board.WorkerCached(*saved)})
}

// workerWriteFailed answers a refused or failed write of a worker and reports true.
func (h *BoardHandler) workerWriteFailed(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, board.ErrWorkerNotFound):
		errNotFound(w, err.Error())
	case errors.Is(err, board.ErrWorkerExists), errors.Is(err, board.ErrWorkerLimit):
		writeError(w, http.StatusConflict, "worker_conflict", err.Error())
	case strings.HasPrefix(err.Error(), "a worker") || strings.HasPrefix(err.Error(), "a skill"):
		errBadRequest(w, err.Error())
	default:
		errInternalServer(w, "could not save the worker")
	}
	return true
}

// tellOrchestratorWorkersChanged posts a board notice to the team's Orchestrator with the list as it is now, so the Orchestrator needs no telling (the system prompt carries the same text at every start).
func (h *BoardHandler) tellOrchestratorWorkersChanged(ctx context.Context, project string) {
	orch, err := h.bs.TeamOrchestrator(ctx, project)
	if err != nil || orch == "" {
		return
	}
	list, err := h.bs.ListWorkers(ctx, project)
	if err != nil {
		return
	}
	names := []string{orch}
	body := board.WorkersBrief(list)
	if body == "" {
		body = "The team has no approved workers now: launch your own setup with coral-agent launch."
	}
	content := fmt.Sprintf("@%s [Coral] The Operator changed the team's approved workers.\n%s", orch, board.DefuseMentions(body, names))
	if _, err := h.bs.PostSystemDefusedMessage(ctx, project, board.CoralSender, content, nil); err != nil {
		return
	}
}

// LaunchWorker answers POST /api/board/{project}/workers/{name}/launch {"task_id": N}: it starts an agent from the approved worker, with the worker's instructions and then the task's text as its first message.
// An agent may call it only for its own team. The launch is Launch itself, called with the saved setup, so the agent's launch rules all apply (the cap, the limit, the log, the folders, the name).
func (h *SessionsHandler) LaunchWorker(w http.ResponseWriter, r *http.Request) {
	project, name := chi.URLParam(r, "project"), chi.URLParam(r, "name")
	if h.bs == nil {
		errInternalServer(w, "the board is not available")
		return
	}
	if owner, ok := VerifiedSession(r.Context()); ok { // an agent launches the workers of its own team and no other
		own := ""
		if h.ss != nil {
			if sess, err := h.ss.GetLiveSession(r.Context(), owner.SessionID); err == nil && sess != nil && sess.BoardName != nil {
				own = *sess.BoardName
			}
		}
		if own == "" || own != project {
			writeError(w, http.StatusForbidden, "worker_other_team", "an agent starts only the workers of its own team")
			return
		}
	}
	var in struct {
		TaskID   int64 `json:"task_id"`
		Worktree bool  `json:"worktree"` // start it in its own worktree task-N (#21481); needs a task
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := decodeJSONStrict(r, &in); err != nil {
		errBadRequest(w, `send {"task_id": N}`)
		return
	}
	if in.Worktree && in.TaskID <= 0 {
		errBadRequest(w, "worktree needs a task: the worktree is called task-N")
		return
	}
	worker, err := h.bs.GetWorker(r.Context(), project, name)
	if errors.Is(err, board.ErrWorkerNotFound) {
		errNotFound(w, "this team has no approved worker called "+clitext.Clean(name)+": coral-board worker list shows them")
		return
	}
	if err != nil {
		errInternalServer(w, "could not read the worker")
		return
	}
	taskText := ""
	if in.TaskID > 0 {
		task, err := h.bs.GetTask(r.Context(), project, in.TaskID)
		if err != nil || task == nil {
			errNotFound(w, fmt.Sprintf("this team has no task #%d", in.TaskID))
			return
		}
		body := ""
		if task.Body != nil {
			body = *task.Body
		}
		taskText = workerTaskText(task.ID, task.Title, body)
	}
	display := h.freeWorkerName(r.Context(), project, worker.Name, in.TaskID)
	prompt := workerLaunchPrompt(worker, taskText)
	req := map[string]any{
		"agent_type": worker.AgentType, "display_name": display, "board_id": project, "board_name": project, "prompt": prompt,
	}
	if worker.WorkingDir != "" {
		req["working_dir"] = worker.WorkingDir
	}
	if worker.Model != "" {
		req["model"] = worker.Model
	}
	if worker.Thinking != "" {
		req["thinking"] = worker.Thinking
	}
	if len(worker.Skills) > 0 {
		req["skills"] = worker.Skills
	}
	if worker.PermissionMode == "default" || (strings.HasPrefix(worker.PermissionMode, "custom:") && !agentCaller(r)) { // an agent never starts an agent in a custom mode
		req["permission_mode"] = worker.PermissionMode
	}
	if in.Worktree {
		req["worktree_task"] = in.TaskID
	}
	raw, _ := json.Marshal(req)
	inner2, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, "/api/sessions/launch", strings.NewReader(string(raw)))
	inner2.Header, inner2.RemoteAddr, inner2.Host, inner2.TLS = r.Header.Clone(), r.RemoteAddr, r.Host, r.TLS
	inner2.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Launch(rec, inner2)
	var result map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	if rec.Code != http.StatusOK || result == nil {
		for k, v := range rec.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
		return
	}
	_ = h.bs.RecordWorkerLaunch(r.Context(), project, display, worker.Name, in.TaskID) // keyed by the agent's name on the team, which is how its row and page are found
	result["worker"], result["display_name"] = worker.Name, display
	writeJSON(w, http.StatusOK, result)
}

// workerLaunchPrompt is the first message of a launched worker: the worker's instructions, a blank line, then the task's text. The instructions come first and are the same for every worker of the kind, so the provider can reuse that opening between launches.
func workerLaunchPrompt(worker *board.Worker, taskText string) string {
	prompt := worker.Instructions
	if taskText != "" {
		if prompt != "" {
			prompt += "\n\n"
		}
		prompt += taskText
	}
	return prompt
}

// workerTaskText is a task as the first message of the worker started for it.
func workerTaskText(id int64, title, body string) string {
	text := fmt.Sprintf("Your task is #%d: %s", id, strings.TrimSpace(clitext.Clean(title)))
	if b := strings.TrimSpace(body); b != "" {
		text += "\n\n" + b
	}
	if utf8.RuneCountInString(text) > maxWorkerTaskText {
		text = string([]rune(text)[:maxWorkerTaskText]) + "…"
	}
	return text + fmt.Sprintf("\n\nThe board has the rest: coral-board task detail %d.", id)
}

// freeWorkerName is the name the new agent takes: "<worker> #N" for a task, "<worker>" for none, with a number after it when the team has an agent of that name already (names are unique in a team).
func (h *SessionsHandler) freeWorkerName(ctx context.Context, project, worker string, taskID int64) string {
	base := worker
	if taskID > 0 {
		base = fmt.Sprintf("%s #%d", worker, taskID)
	}
	taken := map[string]bool{}
	if subs, err := h.bs.ListSubscribers(ctx, project); err == nil {
		for _, s := range subs {
			taken[strings.ToLower(s.SubscriberID)] = true
		}
	}
	name := base
	for n := 2; taken[strings.ToLower(name)]; n++ {
		name = fmt.Sprintf("%s %d", base, n)
	}
	return name
}
