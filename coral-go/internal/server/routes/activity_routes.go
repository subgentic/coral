package routes

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/subgentic/coral/internal/board"
)

// The Operator's clicks that are recorded by their route (#13609). A click the Operator makes in the dashboard changes something; the Activity record says so. The handlers that decide something
// of their own (a file's review, a question's Ignore, a goal's close) write their row in their own transaction. Every other route a person's click can reach is listed here, with the row it writes:
// ActivityRecorder writes it after the handler has answered 2xx, and only for a person (humanInputCaller: the dashboard's cookie or none at this computer, or the Hub owner's stamped call). An agent's
// token calling the same route, a failed call and a refused call write nothing. The route table is the census: TestEveryMutatingRouteIsInTheActivityCensus fails for a route that is in no list of
// activity_census_test.go, so a new action cannot go unrecorded by being forgotten.
type activityRoute struct {
	Action string
	Kind   string // task, agent, message
	ID     string // the URL parameter that names the item
	Team   string // the URL parameter that names the board ("" when the route has none)
}

var activityRoutes = map[string]activityRoute{
	"POST /api/board/{project}/tasks":                     {board.ActTaskCreate, "task", "", "project"},
	"POST /api/board/{project}/tasks/{taskID}/complete":   {board.ActTaskComplete, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/cancel":     {board.ActTaskCancel, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/publish":    {board.ActTaskPublish, "task", "taskID", "project"},
	"PATCH /api/board/{project}/tasks/{taskID}":           {board.ActTaskEdit, "task", "taskID", "project"},
	"PATCH /api/board/{project}/tasks/{taskID}/amend":     {board.ActTaskEdit, "task", "taskID", "project"},
	"PUT /api/board/{project}/tasks/{taskID}/goal":        {board.ActTaskEdit, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/reassign":   {board.ActTaskEdit, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/nudge":      {board.ActTaskRemind, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/reminder":   {board.ActTaskRemind, "task", "taskID", "project"},
	"DELETE /api/board/{project}/tasks/{taskID}/reminder": {board.ActTaskRemind, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/park":       {board.ActTaskPark, "task", "taskID", "project"},
	"DELETE /api/board/{project}/tasks/{taskID}/park":     {board.ActTaskPark, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/release":    {board.ActTaskPark, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/approve":    {board.ActApprove, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/reject":     {board.ActDeny, "task", "taskID", "project"},
	"POST /api/board/{project}/tasks/{taskID}/send-back":  {board.ActChanges, "task", "taskID", "project"},
	"POST /api/sessions/live/{name}/answer-prompt":        {board.ActPromptAnswer, "agent", "name", ""},
	"POST /api/sessions/live/{name}/dismiss-wait":         {board.ActWaitDismiss, "agent", "name", ""},
	"POST /api/sessions/live/{name}/waiting/dismiss":      {board.ActWaitDismiss, "agent", "name", ""},
	"PUT /api/artifacts/{id}/star":                        {board.ActFileStar, "file", "id", ""},
	"DELETE /api/artifacts/{id}/star":                     {board.ActFileUnstar, "file", "id", ""},
	"PUT /api/artifacts/{id}/keep":                        {board.ActFileKeep, "file", "id", ""},
	"DELETE /api/artifacts/{id}/keep":                     {board.ActFileRelease, "file", "id", ""},
	"DELETE /api/artifacts/{id}":                          {board.ActFileDelete, "file", "id", ""},
	"DELETE /api/artifacts/series/{series_id}":            {board.ActFileDelete, "file", "series_id", ""},
	"POST /api/board/{project}/operator-artifacts":        {board.ActFileShare, "file", "", "project"},
	"POST /api/saved":                                             {board.ActSavedAdd, "message", "", ""},
	"PATCH /api/saved/{id}":                                       {board.ActSavedUpdate, "message", "id", ""},
	"DELETE /api/saved/{id}":                                      {board.ActSavedRemove, "message", "id", ""},
	"PATCH /api/sessions/history/{sessionID}/flags":               {board.ActChatFlag, "chat", "sessionID", ""},
	"POST /api/workflows/runs/{runID}/seen":                       {board.ActRunSeen, "run", "runID", ""},
	"POST /api/scheduled/runs/{runID}/seen":                       {board.ActRunSeen, "run", "runID", ""},
	"POST /api/sessions/record-agents":                            {board.ActAgentsRecord, "agent", "", ""},
	"POST /api/board/{project}/goals":                             {board.ActGoalCreate, "goal", "", "project"},
	"PATCH /api/board/{project}/goals/{goalID}":                   {board.ActGoalEdit, "goal", "goalID", "project"},
	"POST /api/board/{project}/goals/{goalID}/driver":             {board.ActGoalDriver, "goal", "goalID", "project"},
	"POST /api/board/{project}/goals/{goalID}/move":               {board.ActGoalMove, "goal", "goalID", "project"},
	"POST /api/board/{project}/goal-requests/{requestID}/accept":  {board.ActGoalRequestAdd, "goal_request", "requestID", "project"},
	"POST /api/board/{project}/goal-requests/{requestID}/decline": {board.ActGoalRequestNo, "goal_request", "requestID", "project"},
	"POST /api/sessions/live/{name}/send":                         {board.ActChatSend, "agent", "name", ""},
	"POST /api/sessions/live/{name}/waiting/send":                 {board.ActWaitSend, "agent", "name", ""},
}

// ActivityRoutes is the table's keys and the action each writes, for the census test.
func ActivityRoutes() map[string]string {
	out := make(map[string]string, len(activityRoutes))
	for k, v := range activityRoutes {
		out[k] = v.Action
	}
	return out
}

// ActivityRecorder writes the row of a listed route after its handler answered 2xx, for a person only. It wraps writes only (a GET is never an action), and a row that cannot be written is logged by the
// store and never changes the answer: the record does not block the Operator.
func ActivityRecorder(bs *board.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
			default:
				next.ServeHTTP(w, r)
				return
			}
			ww := chimw.NewWrapResponseWriter(w, r.ProtoMajor)
			pend := &activityPending{}
			r = r.WithContext(context.WithValue(r.Context(), activityPendingKey{}, pend))
			next.ServeHTTP(ww, r)
			status := ww.Status()
			if status == 0 {
				status = http.StatusOK
			}
			if bs == nil || status < 200 || status >= 300 {
				return
			}
			rctx := chi.RouteContext(r.Context())
			if rctx == nil {
				return
			}
			if pend.set { // a handler that knows more than its route does (the body, a header) said which row this click is
				if humanInputCaller(r) {
					_ = bs.RecordActivity(context.WithoutCancel(r.Context()), activityMetaFor(r, pend.title, pend.note), pend.action, pend.kind, pend.item, "", pend.team)
				}
				return
			}
			ar, ok := activityRoutes[r.Method+" "+rctx.RoutePattern()]
			if !ok || !humanInputCaller(r) {
				return
			}
			team, item := "", ""
			if ar.Team != "" {
				team = urlParam(r, ar.Team)
			}
			if ar.ID != "" {
				item = urlParam(r, ar.ID)
			}
			ctx := context.WithoutCancel(r.Context())
			title := ""
			if ar.Kind == "task" && team != "" {
				if id, err := strconv.ParseInt(item, 10, 64); err == nil && id > 0 {
					if t, err := bs.GetTask(ctx, team, id); err == nil && t != nil {
						title = t.Title
					}
				}
			}
			if ar.Kind == "goal" && team != "" {
				if id, err := strconv.ParseInt(item, 10, 64); err == nil && id > 0 {
					if g, err := bs.GetGoal(ctx, team, id); err == nil && g != nil {
						title = g.Title
					}
				}
			}
			_ = bs.RecordActivity(ctx, activityMetaFor(r, title, ""), ar.Action, ar.Kind, item, "", team)
		})
	}
}

// recordWords writes the row of an action whose words the Operator typed (a reply, a message): the same person-only rule, with the words as the row's note (redacted and cut by activityMetaFor).
func (h *BoardHandler) recordWords(r *http.Request, action, kind, item, team, title, words string) {
	if h.bs == nil || !humanInputCaller(r) {
		return
	}
	_ = h.bs.RecordActivity(context.WithoutCancel(r.Context()), activityMetaFor(r, title, words), action, kind, item, "", team)
}

type activityPendingKey struct{}

// activityPending is the row a handler asked for: the recorder writes it after the handler answered 2xx, for a person only, so the handler never checks the caller or the status itself.
type activityPending struct {
	set                                   bool
	action, kind, item, team, title, note string
}

// noteActivity asks the recorder for a row for this request's click; the last call wins. Outside the recorder (a handler called on its own in a test) it does nothing.
func noteActivity(r *http.Request, action, kind, item, team, title, note string) {
	if p, _ := r.Context().Value(activityPendingKey{}).(*activityPending); p != nil {
		*p = activityPending{true, action, kind, item, team, title, note}
	}
}
