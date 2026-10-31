package routes

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/cloud"
)

// Goals on the board (#7087, from #7078's note). A goal is an outcome a board's tasks work toward; the store is internal/board/goals.go. These routes write board text and nothing else: they never
// start, wake, resume or message an agent (the one side effect a task made under a goal keeps is the nudge to an awake assignee that every task has), which is what lets Coral Hub offer them at
// Interact. Who may write: the Operator and an active registered orchestrator (the people who plan a board's tasks); anyone who reads the board may read goals.
//
//	POST  /api/board/{project}/goals                 {title, outcome?, done_when?, state?, driver?, subscriber_id}          -> 201 the goal
//	GET   /api/board/{project}/goals?state=a,b       default: proposed, active, blocked                                      -> {"goals": [...]}
//	GET   /api/board/{project}/goals/{goalID}                                                                                -> the goal
//	PATCH /api/board/{project}/goals/{goalID}        any of title, outcome, done_when, state, blocked_on, driver, with
//	                                                 subscriber_id                                                           -> the goal
//	POST  /api/board/{project}/goals/{goalID}/close  {reason, state? done|dropped, subscriber_id}                            -> {"goal": ..., "open_tasks": n}
//	PUT   /api/board/{project}/tasks/{taskID}/goal   {goal_id: n | null, subscriber_id}                                      -> the task
//	GET   /api/board/{project}/tasks?goal=<id>       the goal's tasks, as the usual task page

// goalError answers a goal refusal with its fixed word and says it did: 404 for a goal or task that is not there (another board's goal is not there), 409 for a closed goal, 400 for the rest.
func goalError(w http.ResponseWriter, err error) bool {
	var ge *board.GoalError
	if !errors.As(err, &ge) {
		return false
	}
	status := http.StatusBadRequest
	switch ge.Code {
	case board.ErrGoalNotFound.Code, board.ErrGoalTaskNotFound.Code:
		status = http.StatusNotFound
	case board.ErrGoalClosed.Code, board.ErrGoalAlreadyClosed.Code, board.ErrGoalNotClosed.Code, "goal_limit":
		status = http.StatusConflict
	}
	writeError(w, status, ge.Code, ge.Message)
	return true
}

// plannerWords are the words of a refused planner check and the name its log-only count goes under: the check is one (who may plan a board's goals and send its goal requests: the Operator, or an active registered
// orchestrator), and the goal write and the request send give it their own sentences (#7389; #7382 had the send in a copy).
type plannerWords struct {
	counter      string // the name a log-only difference is counted under
	operatorOnly string // refused under enforced identity: the name "Operator" with no verified Operator behind it
	notPlanner   string // refused: not an active registered orchestrator of the board
}

// goalWriteWords is what the goal write says.
var goalWriteWords = plannerWords{
	counter:      "goal-planner",
	operatorOnly: "only the Operator or an active registered orchestrator may create or change goals",
	notPlanner:   "only Operator or an active registered orchestrator may create or change goals; coordinate with your orchestrator",
}

// goalRequestSendWords is what the request send says for the board it sends from: its sentence names the job title, which is a literal word a worker does not have.
func goalRequestSendWords(from string) plannerWords {
	msg := fmt.Sprintf("only the Operator or an active Orchestrator of %q can send its goal requests: the member's job title must be the word Orchestrator (a Developer or any other title is refused)", from)
	return plannerWords{counter: "goal-request-sender", operatorOnly: msg, notPlanner: msg}
}

// requirePlanner is the check: the Operator (as the identity layer verified it), or an active registered orchestrator of project. It answers the refusal itself, in words.
func (h *BoardHandler) requirePlanner(w http.ResponseWriter, r *http.Request, project, actor string, words plannerWords) bool {
	if callerActor(r).IsOperator() {
		return true
	}
	if actor == "Operator" {
		if identityActorEnforced() {
			errForbidden(w, words.operatorOnly)
			return false
		}
		noteEnforceDiffers(words.counter, r)
		return true
	}
	if err := h.bs.RequireTaskReviewer(r.Context(), project, actor); err != nil {
		errForbidden(w, words.notPlanner)
		return false
	}
	return true
}

// plannerActor is who acts: the name the request claims, as the identity layer verified it, and allowed to plan the board. It answers the refusal itself.
func (h *BoardHandler) plannerActor(w http.ResponseWriter, r *http.Request, project, claim string, words plannerWords) (string, bool) {
	who, ok := attributedTo(w, r, claim)
	if !ok {
		return "", false
	}
	actor := strings.TrimSpace(claim)
	if identityActorEnforced() {
		actor = who
	}
	if actor == "" {
		errBadRequest(w, "subscriber_id required")
		return "", false
	}
	if !h.requirePlanner(w, r, project, actor, words) {
		return "", false
	}
	return actor, true
}

// goalActor is who writes a goal. It answers the refusal itself.
func (h *BoardHandler) goalActor(w http.ResponseWriter, r *http.Request, project, claim string) (string, bool) {
	return h.plannerActor(w, r, project, claim, goalWriteWords)
}

func goalID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := parseID(chi.URLParam(r, "goalID"))
	if err != nil || id <= 0 {
		errBadRequest(w, "invalid goal ID")
		return 0, false
	}
	return id, true
}

// CreateGoal: POST /api/board/{project}/goals
func (h *BoardHandler) CreateGoal(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	var body struct {
		Title        string `json:"title"`
		Outcome      string `json:"outcome"`
		DoneWhen     string `json:"done_when"`
		State        string `json:"state"`
		Driver       string `json:"driver"`
		SubscriberID string `json:"subscriber_id"`
		CreatedBy    string `json:"created_by"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	if refuseNewBoardName(w, r, h.bs, project) {
		return
	}
	claim := body.SubscriberID
	if claim == "" {
		claim = body.CreatedBy
	}
	actor, ok := h.goalActor(w, r, project, claim)
	if !ok {
		return
	}
	if hold, ok := h.needsApproval(r, project, board.ProposalGoal); !ok {
		errInternalServer(w, "could not read the board's settings")
		return
	} else if hold { // this team's goals need the Operator's approval (#11389): an agent's goal is a proposal until it is approved
		in := board.GoalInput{Title: body.Title, Outcome: body.Outcome, DoneWhen: body.DoneWhen, State: body.State, Driver: body.Driver, CreatedBy: actor}
		if err := board.ValidateGoalInput(in); err != nil {
			if !goalError(w, err) {
				errBadRequest(w, err.Error())
			}
			return
		}
		payload, _ := json.Marshal(goalPayload{Title: body.Title, Outcome: body.Outcome, DoneWhen: body.DoneWhen, State: body.State, Driver: body.Driver, CreatedBy: verifiedName(r, actor)})
		h.proposeAnswer(w, r, board.ProposalInput{Board: project, Kind: board.ProposalGoal, Title: body.Title, Payload: payload, Proposer: actor})
		return
	}
	g, err := h.bs.CreateGoal(r.Context(), project, board.GoalInput{Title: body.Title, Outcome: body.Outcome, DoneWhen: body.DoneWhen, State: body.State, Driver: body.Driver, CreatedBy: actor})
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusCreated, g)
}

// ListGoals: GET /api/board/{project}/goals?state=a,b&limit=n&cursor=c. A page of the board's goals, oldest first, in the task list's shape: limit defaults to 50 and is at most 200, next_cursor
// continues it and is "" on the last page; a cursor holds the board and the state filter it was made for (#7239).
func (h *BoardHandler) ListGoals(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	query := r.URL.Query()
	q := board.GoalListQuery{Cursor: query.Get("cursor")}
	if s := strings.TrimSpace(query.Get("state")); s != "" {
		q.States = strings.Split(s, ",")
		for i := range q.States {
			q.States[i] = strings.TrimSpace(q.States[i])
		}
	}
	if l := query.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n <= 0 {
			errBadRequest(w, "limit must be a positive number")
			return
		}
		q.Limit = n
	}
	page, err := h.bs.GoalPage(r.Context(), project, q)
	if errors.Is(err, board.ErrBadTaskListQuery) {
		errBadRequest(w, err.Error())
		return
	}
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// ListAllGoals: GET /api/goals?state=a,b&board=x&board=y&limit=n&cursor=c (#7260). The goals of every board (or the boards named) in one call, oldest first by id, in the per-board read's page shape with each goal's
// board_id and rollup and no tasks. The Operator's, like GET /api/board/tasks (an agent's token is refused by the identity layer: operatorOnlyRoutes); a View viewer through Coral Hub gets the same reply, redacted for secrets. An unknown or mistyped parameter is a 400 that names it,
// never a silent fall-back to the unfiltered list; a board that has no goals, or does not exist, adds nothing.
func (h *BoardHandler) ListAllGoals(w http.ResponseWriter, r *http.Request) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		errBadRequest(w, "the query string is not valid (no ';', and %-escapes must be two hex digits)")
		return
	}
	for k := range query {
		switch k {
		case "state", "board", "limit", "cursor":
		default:
			errBadRequest(w, "unknown parameter "+k)
			return
		}
	}
	for _, k := range []string{"state", "limit", "cursor"} {
		if len(query[k]) > 1 {
			errBadRequest(w, k+" is given more than once")
			return
		}
	}
	q := board.AllGoalsQuery{Cursor: query.Get("cursor")}
	split := func(name string, vals []string) ([]string, bool) {
		var out []string
		seen := map[string]bool{}
		for _, v := range vals {
			for _, p := range strings.Split(v, ",") {
				p = strings.TrimSpace(p)
				if p == "" || len(p) > 200 {
					errBadRequest(w, name+" has an empty value or one over 200 characters")
					return nil, false
				}
				if !seen[p] {
					seen[p] = true
					out = append(out, p)
				}
			}
		}
		return out, true
	}
	var ok bool
	if q.States, ok = split("state", query["state"]); !ok {
		return
	}
	if q.Boards, ok = split("board", query["board"]); !ok {
		return
	}
	if len(q.Boards) > board.AllGoalsMaxBoards {
		errBadRequest(w, "board names more than "+strconv.Itoa(board.AllGoalsMaxBoards)+" boards")
		return
	}
	for _, b := range q.Boards {
		for _, c := range b { // a board that already exists keeps any name (names.go): spaces and dots are fine, control characters are not; a name nobody has simply adds nothing
			if c < 0x20 || c == 0x7f {
				errBadRequest(w, "board can't contain a control character")
				return
			}
		}
	}
	if cloud.Tunneled(r) { // redacted after the filter matched: a board value the redactor would change can match nothing the viewer sees (as the machine-wide task query)
		for _, v := range q.Boards {
			if shownText(v) != v {
				errBadRequest(w, "board can't contain a secret (a token, a key or a password): it would match what the redaction hides")
				return
			}
		}
	}
	if l := query.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n <= 0 {
			errBadRequest(w, "limit must be a positive number")
			return
		}
		q.Limit = n
	}
	page, err := h.bs.AllGoalsPage(r.Context(), q)
	if errors.Is(err, board.ErrBadTaskListQuery) {
		errBadRequest(w, err.Error())
		return
	}
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// GetGoal: GET /api/board/{project}/goals/{goalID}
func (h *BoardHandler) GetGoal(w http.ResponseWriter, r *http.Request) {
	id, ok := goalID(w, r)
	if !ok {
		return
	}
	project := urlParam(r, "project")
	g, err := h.bs.GetGoal(r.Context(), project, id)
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	// The requests this goal sent that were accepted (#7361): where it asked, never what the other team made of it (no task, count or title). The cap is 20; the total says how many more.
	refs, total, err := h.bs.AcceptedGoalRequests(r.Context(), project, id)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, struct {
		*board.Goal
		AcceptedRequests      []board.AcceptedRequestRef `json:"accepted_requests"`
		AcceptedRequestsTotal int                        `json:"accepted_requests_total"`
	}{g, refs, total})
}

// UpdateGoal: PATCH /api/board/{project}/goals/{goalID}. Only the fields the body names change; "driver": "" clears the driver.
func (h *BoardHandler) UpdateGoal(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	id, ok := goalID(w, r)
	if !ok {
		return
	}
	var body struct {
		Title        *string `json:"title"`
		Outcome      *string `json:"outcome"`
		DoneWhen     *string `json:"done_when"`
		State        *string `json:"state"`
		BlockedOn    *string `json:"blocked_on"`
		Driver       *string `json:"driver"`
		SubscriberID string  `json:"subscriber_id"`
	}
	// a field that cannot be changed (id, goal_uid, board_id, closed_at) or is mistyped is refused by name, not dropped (#7239)
	if err := decodeJSONStrict(r, &body); err != nil {
		if name, ok := strings.CutPrefix(err.Error(), "json: unknown field "); ok {
			errBadRequest(w, fmt.Sprintf("unknown field %s: a goal's title, outcome, done_when, state, blocked_on, driver and subscriber_id can be sent", shortKey(strings.Trim(name, `"`))))
			return
		}
		errBadRequest(w, "invalid JSON")
		return
	}
	if _, ok := h.goalActor(w, r, project, body.SubscriberID); !ok {
		return
	}
	g, err := h.bs.UpdateGoal(r.Context(), project, id, board.GoalUpdate{Title: body.Title, Outcome: body.Outcome, DoneWhen: body.DoneWhen, State: body.State, BlockedOn: body.BlockedOn, Driver: body.Driver})
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// postGoalLine posts a board message for a goal change, as the person who made it: the Operator or an orchestrator by name, or through Coral Hub the Operator with the Hub user noted, as a chat post is.
// The goal write is done and answered either way: a message that cannot be posted is logged, not made the write's failure.
func (h *BoardHandler) postGoalLine(r *http.Request, project, actor, content string) {
	var err error
	if user := hubOperatorUser(r); cloud.Tunneled(r) && user != "" {
		_, err = h.bs.PostHubMessage(r.Context(), project, user, HubOperatorPrefix(user)+content, nil, true)
	} else { // not through the Hub, or a Hub write with no Hub user to name (the guard has one for every write that reaches here): the actor's own post
		_, err = h.bs.PostMessage(r.Context(), project, actor, content, nil)
	}
	if err != nil {
		slog.Warn("goal board message not posted", "project", project, "error", err)
		return
	}
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
}

// CloseGoal: POST /api/board/{project}/goals/{goalID}/close. A goal with open tasks is closed all the same: the answer says how many were open, so the caller can warn.
func (h *BoardHandler) CloseGoal(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	id, ok := goalID(w, r)
	if !ok {
		return
	}
	var body struct {
		Reason       string `json:"reason"`
		State        string `json:"state"`
		SubscriberID string `json:"subscriber_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	actor, ok := h.goalActor(w, r, project, body.SubscriberID)
	if !ok {
		return
	}
	g, open, err := h.bs.CloseGoal(r.Context(), project, id, body.Reason, body.State)
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	noun := "open tasks"
	if open == 1 {
		noun = "open task"
	}
	h.postGoalLine(r, project, actor, "Goal #"+strconv.FormatInt(g.ID, 10)+" \""+g.Title+"\" is closed as "+g.State+": "+g.ClosedReason+" ("+strconv.Itoa(open)+" "+noun+" left)")
	writeJSON(w, http.StatusOK, map[string]any{"goal": g, "open_tasks": open})
}

// SetTaskGoal: PUT /api/board/{project}/tasks/{taskID}/goal {"goal_id": n | null}. null unlinks; a goal that is not on this board, or is closed, is refused.
func (h *BoardHandler) SetTaskGoal(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	taskID, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil || taskID <= 0 {
		errBadRequest(w, "invalid task ID")
		return
	}
	var body struct {
		GoalID       json.RawMessage `json:"goal_id"`
		SubscriberID string          `json:"subscriber_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	if len(body.GoalID) == 0 {
		errBadRequest(w, "goal_id is required: a goal's number, or null to unlink")
		return
	}
	var goal *int64
	if string(body.GoalID) != "null" {
		var n int64
		if err := json.Unmarshal(body.GoalID, &n); err != nil || n <= 0 {
			errBadRequest(w, "goal_id must be a goal's number, or null")
			return
		}
		goal = &n
	}
	if _, ok := h.goalActor(w, r, project, body.SubscriberID); !ok {
		return
	}
	if err := h.bs.SetTaskGoal(r.Context(), project, taskID, goal); err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	task, err := h.bs.GetTask(r.Context(), project, taskID)
	if err != nil {
		errTaskStore(w, err)
		return
	}
	writeJSON(w, http.StatusOK, task)
}

// shortKey is a query key as the 400 echoes it: cleaned of control and bidi characters and cut at 40 characters.
func shortKey(k string) string {
	k = clitext.CleanName(k)
	if r := []rune(k); len(r) > 40 {
		k = string(r[:40]) + "..."
	}
	return k
}

// listGoalTasks answers GET .../tasks?goal=<id>[&status=open|completed|all][&limit=n][&cursor=c] with a page of a goal's tasks, oldest first, in the shape of the task page: next_cursor continues it, empty on the last page.
func (h *BoardHandler) listGoalTasks(w http.ResponseWriter, r *http.Request, project, raw string) {
	id, err := parseID(raw)
	if err != nil || id <= 0 {
		errBadRequest(w, "goal must be a goal's number")
		return
	}
	q := r.URL.Query()
	for k := range q { // a filter this read does not have is refused by name, not left out: a mistyped one would read the goal's whole list (#7239)
		switch k {
		case "goal", "status", "limit", "cursor":
		default:
			errBadRequest(w, fmt.Sprintf("a goal's task read takes goal, status, limit and cursor, not %q", shortKey(k)))
			return
		}
	}
	limit := 0
	if l := q.Get("limit"); l != "" {
		if limit, err = strconv.Atoi(l); err != nil || limit <= 0 {
			errBadRequest(w, "limit must be a positive number")
			return
		}
	}
	page, err := h.bs.GoalTaskPage(r.Context(), project, id, q.Get("status"), q.Get("cursor"), limit)
	if errors.Is(err, board.ErrBadTaskListQuery) {
		errBadRequest(w, err.Error())
		return
	}
	if err != nil {
		if !goalError(w, err) {
			errInternalServer(w, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, page)
}
