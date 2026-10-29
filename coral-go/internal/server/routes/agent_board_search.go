package routes

import (
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// agentBoardSearchParams are the parameters GET /api/agent/board/search takes: the dashboard search's (without for_subscriber, which is a viewer's switch), the reach, and the session the caller names (checked
// against its token like every agent history call). Anything else is a 400 naming it.
var agentBoardSearchParams = map[string]bool{"q": true, "from": true, "mentions": true, "since": true, "until": true, "sort": true, "limit": true, "cursor": true, "reach": true, "session_id": true}

// refuseSearchReach answers a reach the agent was not given with 403 search_reach_refused and no data (#11005): never a quiet narrowing to what it may read. Until the operator-set levels exist (a later phase of
// #11005) every agent searches at "own", so the words say it is not available rather than pointing at a control that is not there yet.
func refuseSearchReach(w http.ResponseWriter, requested string) {
	writeJSON(w, http.StatusForbidden, map[string]any{
		"error":     "Refused: this agent's search access is 'own', its own board. Searching beyond it (--" + flagOfReach(requested) + ") is not available yet.",
		"code":      "search_reach_refused",
		"level":     "own",
		"requested": requested,
	})
}

func flagOfReach(reach string) string {
	if reach == "operator" {
		return "operator-history"
	}
	return reach
}

// SearchAgentBoard is GET /api/agent/board/search (#11005, phase (a)): an agent's search of the messages of its OWN board. The board is the one launch board its live row names, by board KEY (never a label, and
// never a seat: a seat the Operator made on another board does not widen it, and two boards with one label are told apart), and the caller is the token's session (a session_id naming another is refused). The
// search is the dashboard's (text, from, mentions, since, until, sort, paging) over that one board. A reach above "own" is refused (refuseSearchReach); reads at "own" are the agent's own and are not logged.
func (h *SessionsHandler) SearchAgentBoard(w http.ResponseWriter, r *http.Request) {
	vals, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		errBadRequest(w, "the query string is not valid (no ';', and %-escapes must be two hex digits)")
		return
	}
	var unknown []string
	for k := range vals {
		if !agentBoardSearchParams[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		errBadRequest(w, "unknown parameter "+strings.Join(unknown, ", "))
		return
	}
	sessionID, ok := historyCaller(w, r, vals)
	if !ok {
		return
	}
	switch reach := strings.ToLower(strings.TrimSpace(vals.Get("reach"))); reach {
	case "", "own":
	case "team", "all", "operator":
		refuseSearchReach(w, reach)
		return
	default:
		errBadRequest(w, "reach must be own, team, all or operator")
		return
	}
	if h.bs == nil || h.ss == nil {
		errInternalServer(w, "the board is not available")
		return
	}
	ls, err := h.ss.GetLiveSession(r.Context(), sessionID)
	if err != nil {
		errInternalServer(w, "could not read this agent's launch record")
		return
	}
	if ls == nil || ls.BoardName == nil || *ls.BoardName == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "This agent was not launched on a board, so it has no board to search", "code": "no_board"})
		return
	}
	boardKey := *ls.BoardName
	q, err := board.ParseMessageQuery(board.MessageQueryParams{
		Q: vals["q"], From: vals["from"], Mentions: vals["mentions"], Since: vals["since"], Until: vals["until"], Sort: vals["sort"], Limit: vals["limit"], Cursor: vals["cursor"],
	})
	if err != nil {
		if errors.Is(err, board.ErrMessageQuery) {
			errBadRequest(w, strings.TrimPrefix(err.Error(), board.ErrMessageQuery.Error()+": "))
			return
		}
		errInternalServer(w, err.Error())
		return
	}
	q.Project = boardKey // the key the launch recorded, used exactly: nothing the request names picks the board
	res, err := h.bs.QueryMessages(r.Context(), q)
	if err != nil {
		errInternalServer(w, "could not search the messages")
		return
	}
	out := map[string]any{"messages": res.Messages, "total": res.Total, "limit": q.Limit, "board": boardKey, "reach": "own"}
	if res.NextCursor != "" {
		out["next_cursor"] = res.NextCursor
	}
	if res.PrevCursor != "" {
		out["prev_cursor"] = res.PrevCursor
	}
	if res.Truncated {
		out["truncated"] = true
	}
	writeJSON(w, http.StatusOK, out)
}
