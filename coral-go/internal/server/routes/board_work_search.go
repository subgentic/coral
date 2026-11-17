package routes

import (
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
)

// workSearchParams are the parameters GET /api/board/{project}/search takes: the ones of 'coral-board search' that tasks and goals have (#19237, coral-search slice 3).
var workSearchParams = map[string]bool{"q": true, "source": true, "state": true, "goal": true, "assignee": true, "since": true, "until": true, "limit": true}

// SearchBoardWork is GET /api/board/{project}/search, the dashboard's search of a team's tasks and goals (#19237, goal #244):
//
//	?q=<text>&source=tasks|goals|tasks,goals&state=<state>&goal=<n>&assignee=<member>&since=<RFC 3339>&until=<RFC 3339>&limit=N
//
// It is the search 'coral-board search' makes for tasks and goals: the same parameters, the same code (parseSearchSources, searchWorkResults over board.SearchWork) and the same result list,
// {"results": [{source, id, title, snippet, state, goal_id, at}], "more": bool, "board": <key>}, so a word only in a task's body, or a goal's outcome, is found in the dashboard as it is from an agent's shell.
// Board messages keep their own search (/messages/search). Through Coral Hub the viewer sees redacted text and this matches the stored text, so it is refused there and the page falls back to its own filter.
func (h *BoardHandler) SearchBoardWork(w http.ResponseWriter, r *http.Request) {
	vals, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		errBadRequest(w, "the query string is not valid (no ';', and %-escapes must be two hex digits)")
		return
	}
	var unknown []string
	for k := range vals {
		if !workSearchParams[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		errBadRequest(w, "unknown parameter "+strings.Join(unknown, ", "))
		return
	}
	if cloud.Tunneled(r) {
		writeError(w, http.StatusForbidden, "search_not_on_hub", "Searching task and goal text is not offered through Coral Hub")
		return
	}
	sources, err := parseSearchSources(vals)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	delete(sources, "messages") // a board's messages have their own search
	delete(sources, "history")  // and chat history is the agent's own (its session), not a board's
	if len(sources) == 0 {
		sources["tasks"], sources["goals"] = true, true
	}
	q, err := board.ParseMessageQuery(board.MessageQueryParams{Q: vals["q"], Since: vals["since"], Until: vals["until"], Limit: vals["limit"]})
	if err != nil {
		errBadRequest(w, strings.TrimPrefix(err.Error(), board.ErrMessageQuery.Error()+": "))
		return
	}
	project := urlParam(r, "project")
	results, more, err := searchWorkResults(r.Context(), h.bs, project, vals, q.Limit, q.Since, q.Until, nil, nil, sources)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results, "more": more, "board": project})
}
