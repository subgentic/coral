package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// agentBoardSearchParams are the parameters GET /api/agent/board/search takes: the dashboard search's (without for_subscriber, which is a viewer's switch), the reach, and the session the caller names (checked
// against its token like every agent history call). Anything else is a 400 naming it.
var agentBoardSearchParams = map[string]bool{"q": true, "from": true, "mentions": true, "since": true, "until": true, "sort": true, "limit": true, "cursor": true, "reach": true, "session_id": true}

// refuseSearchReach answers a reach above the agent's level with 403 search_reach_refused and no data (#11005, #11048): never a quiet narrowing to what it may read. It names the level the agent has, the level the
// request needs and where the Operator raises it.
func refuseSearchReach(w http.ResponseWriter, level, requested string) {
	writeJSON(w, http.StatusForbidden, map[string]any{
		"error":     "Refused: this agent's search access is '" + level + "'; --" + flagOfReach(requested) + " needs '" + requested + "'. The Operator raises it in the dashboard (the agent's Search access control); an agent cannot.",
		"code":      "search_reach_refused",
		"level":     level,
		"requested": requested,
		"needed":    requested,
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
	who, requested, ok := h.gateSearchReach(w, r, sessionID, vals)
	if !ok {
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
		writeError(w, http.StatusForbidden, "no_board", "This agent was not launched on a board, so it has no board to search")
		return
	}
	boardKey := *ls.BoardName
	boards, err := h.searchBoards(r, who, boardKey, requested)
	if err != nil {
		errInternalServer(w, "could not work out the boards this search reaches")
		return
	}
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
	if requested != store.SearchReachOwn {
		q.Boards = boards
	}
	res, err := h.bs.QueryMessages(r.Context(), q)
	if err != nil {
		errInternalServer(w, "could not search the messages")
		return
	}
	// The response is capped (searchResponseCap): a page that is over it is read again with a smaller limit, so the cursor still points at the first message not returned.
	capped := false
	for q.Limit > 1 {
		raw, _ := json.Marshal(res.Messages)
		if len(raw) <= searchResponseCap {
			break
		}
		capped = true
		q.Limit = len(res.Messages) / 2
		if q.Limit < 1 {
			q.Limit = 1
		}
		if res, err = h.bs.QueryMessages(r.Context(), q); err != nil {
			errInternalServer(w, "could not search the messages")
			return
		}
	}
	if requested != store.SearchReachOwn {
		h.logSearchRead(r, who, requested, "ok", "board-search", boardTargets(boards), int(res.Total))
	}
	out := map[string]any{"messages": res.Messages, "total": res.Total, "limit": q.Limit, "board": boardKey, "reach": requested}
	if res.NextCursor != "" {
		out["next_cursor"] = res.NextCursor
	}
	if res.PrevCursor != "" {
		out["prev_cursor"] = res.PrevCursor
	}
	if res.Truncated || capped {
		out["truncated"] = true
	}
	writeJSON(w, http.StatusOK, out)
}

// boardTargets is the boards a search reached, for the access log: their keys (never their text), or a count when there are many.
func boardTargets(keys []string) string {
	if len(keys) > 10 {
		return strconv.Itoa(len(keys)) + " boards"
	}
	return strings.Join(keys, ",")
}
