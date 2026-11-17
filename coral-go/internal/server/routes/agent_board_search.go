package routes

import (
	"context"
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
var agentBoardSearchParams = map[string]bool{"q": true, "from": true, "mentions": true, "since": true, "until": true, "sort": true, "limit": true, "cursor": true, "reach": true, "session_id": true, "source": true, "state": true, "goal": true, "assignee": true, "agent": true, "author": true, "system": true}

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
	sources, err := parseSearchSources(vals)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	q, err := board.ParseMessageQuery(board.MessageQueryParams{
		Q: vals["q"], From: vals["from"], Mentions: vals["mentions"], Since: vals["since"], Until: vals["until"], Sort: vals["sort"], Limit: vals["limit"], Cursor: vals["cursor"],
		AllWords: []string{"1"}, // an agent asks in words, in any order (#19423)
	})
	if err != nil {
		if errors.Is(err, board.ErrMessageQuery) {
			errBadRequest(w, strings.TrimPrefix(err.Error(), board.ErrMessageQuery.Error()+": "))
			return
		}
		errInternalServer(w, err.Error())
		return
	}
	q.NoSystem = !truthyParam(vals.Get("system")) && len(q.From) == 0 // Coral's own notices (the task queue's) bury the discussion: left out unless asked for with system=1 or named with from
	q.Project = boardKey                                              // the key the launch recorded, used exactly: nothing the request names picks the board
	if requested != store.SearchReachOwn {
		q.Boards = boards
	}
	workLimit := q.Limit
	res := &board.MessageQueryResult{} // tasks or goals only: no message is read
	capped := false
	if sources["messages"] {
		var err error
		if res, err = h.bs.QueryMessages(r.Context(), q); err != nil {
			errInternalServer(w, "could not search the messages")
			return
		}
		// The response is capped (searchResponseCap): a page that is over it is read again with a smaller limit, so the cursor still points at the first message not returned.
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
	}
	if requested != store.SearchReachOwn {
		h.logSearchRead(r, who, requested, "ok", "board-search", boardTargets(boards), int(res.Total))
	}
	var chats []board.WorkHit
	chatsMore := false
	if sources["history"] {
		var refused answer
		if chats, chatsMore, refused = h.searchChatHits(r, sessionID, vals, who, requested, workLimit, q.Since, q.Until, sourceNamed(vals, "history")); refused != nil {
			refused(w)
			return
		}
	}
	results, more, found, err := searchWorkResultsFound(r.Context(), h.bs, boardKey, vals, workLimit, q.Since, q.Until, res.Messages, chats, sources)
	more = more || chatsMore
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	// total is every hit the search can count: all the messages that match (their total) plus the tasks, goals and chat turns found (a search of tasks or goals reads one more than its limit, so with "more" set it is a floor).
	total := int(res.Total) - len(res.Messages) + found
	if total < len(results) {
		total = len(results)
	}
	out := map[string]any{"results": results, "more": more, "messages": res.Messages, "total": total, "limit": q.Limit, "board": boardKey, "reach": requested}
	if requested != store.SearchReachOwn && (sources["tasks"] || sources["goals"]) {
		out["work_scope"] = "this board only" // the wider reach is for messages and past chats; tasks and goals are always the agent's own board's
	}
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

// searchSources are the sources of the one search (#19161, #19236): the board's messages, its tasks and its goals, and the past chats of the caller's reach (the history search's own reach and access levels).
var searchSources = map[string]bool{"messages": true, "tasks": true, "goals": true, "history": true}

// searchSourceNames are the singular and other names a person types for a source (#19448): each is read as the source it means.
var searchSourceNames = map[string]string{"message": "messages", "msg": "messages", "board": "messages", "task": "tasks", "goal": "goals", "chat": "history", "chats": "history", "past": "history"}

// searchStates are the states --state takes: a task's status or a goal's state (#19448). One that is neither is refused with the list, so a typo is not read as "nothing matches".
var searchStates = []string{"pending", "in_progress", "review_pending", "blocked", "draft", "completed", "skipped", "proposed", "active", "done", "dropped"}

func validSearchState(v string) bool {
	for _, st := range searchStates {
		if v == st {
			return true
		}
	}
	return false
}

// sourceNamed says the request named this source itself (not the default mix).
func sourceNamed(vals url.Values, name string) bool {
	for _, v := range vals["source"] {
		for _, n := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(n), name) {
				return true
			}
		}
	}
	return false
}

// parseSearchSources is the sources a request names (comma-separated, repeatable), every one of them when none is named. A filter that only tasks or goals have (state, goal, assignee) leaves the messages out
// unless messages are named; so do from and mentions, which only messages have, leave the tasks and goals out.
func parseSearchSources(vals url.Values) (map[string]bool, error) {
	out := map[string]bool{}
	for _, v := range vals["source"] {
		for _, name := range strings.Split(v, ",") {
			name = strings.ToLower(strings.TrimSpace(name))
			if name == "" {
				continue
			}
			if one, ok := searchSourceNames[name]; ok { // "goal", "task", "message", "chat" and the like (#19448)
				name = one
			}
			if !searchSources[name] {
				return nil, errors.New("unknown source " + strconv.Quote(name) + ": use messages, tasks, goals or history (one or several, comma-separated)")
			}
			out[name] = true
		}
	}
	if len(out) > 0 {
		return out, nil
	}
	workOnly := vals.Get("state") != "" || vals.Get("goal") != "" || vals.Get("assignee") != ""
	msgOnly := vals.Get("from") != "" || vals.Get("mentions") != ""
	histOnly := vals.Get("agent") != "" || vals.Get("author") != ""
	switch {
	case histOnly && !workOnly && !msgOnly:
		out["history"] = true
	case workOnly && !msgOnly && !histOnly:
		out["tasks"], out["goals"] = true, true
	case msgOnly && !workOnly && !histOnly:
		out["messages"] = true
	case histOnly || workOnly || msgOnly:
		return nil, errors.New("these filters belong to different sources: --state, --goal and --assignee to tasks and goals, --from and --mentions to messages, --agent and --author to past chats; name --source for the ones you want")
	default:
		out["messages"], out["tasks"], out["goals"], out["history"] = true, true, true, true
	}
	return out, nil
}

// searchWorkResults is the one result list, shared by the agent's search and the dashboard's (SearchBoardWork, #19237): the tasks and goals that match (own board only) and the messages of the page, newest first, cut to the limit; more says the tasks or goals had others.
func searchWorkResults(ctx context.Context, bs *board.Store, boardKey string, vals url.Values, limit int, since, until string, msgs []board.Message, chats []board.WorkHit, sources map[string]bool) ([]board.WorkHit, bool, error) {
	hits, more, _, err := searchWorkResultsFound(ctx, bs, boardKey, vals, limit, since, until, msgs, chats, sources)
	return hits, more, err
}

// searchWorkResultsFound is searchWorkResults and the number of hits found before the cut to the limit (the messages of the page, the chats and the tasks and goals found): what a total can say.
func searchWorkResultsFound(ctx context.Context, bs *board.Store, boardKey string, vals url.Values, limit int, since, until string, msgs []board.Message, chats []board.WorkHit, sources map[string]bool) ([]board.WorkHit, bool, int, error) {
	if st := strings.ToLower(strings.TrimSpace(vals.Get("state"))); st != "" && !validSearchState(st) && (sources["tasks"] || sources["goals"]) {
		return nil, false, 0, errors.New("unknown state " + strconv.Quote(st) + ": a task is " + strings.Join(searchStates[:7], ", ") + "; a goal is " + strings.Join(searchStates[7:], ", "))
	}
	hits := append([]board.WorkHit(nil), chats...)
	text := strings.TrimSpace(vals.Get("q"))
	terms := board.SearchTerms(text)
	for i := range hits {
		hits[i].Rank = board.WorkRank(terms, hits[i].Title, hits[i].Snippet)
	}
	more := false
	if sources["tasks"] || sources["goals"] {
		wq := board.WorkQuery{Board: boardKey, Text: strings.TrimSpace(vals.Get("q")), State: strings.ToLower(strings.TrimSpace(vals.Get("state"))), Assignee: strings.TrimSpace(vals.Get("assignee")), Since: since, Until: until, Limit: limit, Oldest: strings.EqualFold(strings.TrimSpace(vals.Get("sort")), "oldest")}
		if sources["tasks"] {
			wq.Sources = append(wq.Sources, "tasks")
		}
		if sources["goals"] {
			wq.Sources = append(wq.Sources, "goals")
		}
		if g := strings.TrimSpace(vals.Get("goal")); g != "" {
			id, err := strconv.ParseInt(strings.TrimPrefix(g, "#"), 10, 64)
			if err != nil || id < 1 {
				return nil, false, 0, errors.New("goal must be a goal number")
			}
			wq.GoalID = id
		}
		work, workMore, err := bs.SearchWork(ctx, wq)
		if err != nil {
			return nil, false, 0, errors.New("could not search the tasks and goals")
		}
		hits, more = append(hits, work...), workMore
	}
	for _, m := range msgs {
		title := m.SubscriberID
		if m.JobTitle != "" && m.JobTitle != title {
			title += " (" + m.JobTitle + ")"
		}
		hits = append(hits, board.WorkHit{Source: "message", ID: m.ID, Title: title, Snippet: board.WorkSnippet(text, m.Content), At: m.CreatedAt, Rank: board.WorkRank(terms, "", m.Content)})
	}
	// Several terms, no sort named: the hits that hold them together first, then newest. A named sort is the time order asked for (oldest included: the list used to ignore it).
	named := strings.TrimSpace(vals.Get("sort")) != ""
	byRank := len(terms) > 1 && !named
	oldest := strings.EqualFold(strings.TrimSpace(vals.Get("sort")), "oldest")
	sort.SliceStable(hits, func(i, j int) bool {
		if !named && hits[i].Minor != hits[j].Minor { // a reviewer's "Review #N" task repeats the task it reviews: after the real hits
			return !hits[i].Minor
		}
		if byRank && hits[i].Rank != hits[j].Rank {
			return hits[i].Rank > hits[j].Rank
		}
		if hits[i].At != hits[j].At {
			return (hits[i].At > hits[j].At) != oldest
		}
		return (hits[i].ID > hits[j].ID) != oldest
	})
	found := len(hits)
	if limit > 0 && len(hits) > limit {
		hits, more = hits[:limit], true
	}
	if hits == nil {
		hits = []board.WorkHit{}
	}
	return hits, more, found, nil
}

// searchChatHits is the history source of the one search (#19236): the turns of the caller's chats (its lineage, or the wider reach's) that match, as the one result shape: id is the turn's index in its session, session names
// the chat, title the agent, state the role, at the turn's time. The same search the history route runs, with --agent (sessions of that agent name), --author (user, assistant or both) and the period. In the default mix a
// history that cannot be read (an unknown session, a reach refusal that the messages already answered) is left out; named on purpose it is the answer.
func (h *SessionsHandler) searchChatHits(r *http.Request, sessionID string, vals url.Values, who searchCaller, requested string, limit int, since, until string, named bool) ([]board.WorkHit, bool, answer) {
	text := strings.TrimSpace(vals.Get("q"))
	if text == "" {
		if named {
			return nil, false, func(w http.ResponseWriter) { errBadRequest(w, "searching past chats needs the text to look for") }
		}
		return nil, false, nil
	}
	if len(text) > 1000 {
		return nil, false, func(w http.ResponseWriter) { errBadRequest(w, "query exceeds maximum length of 1000 characters") }
	}
	p := historySearch{query: text, includeAncestors: true, agent: strings.TrimSpace(vals.Get("agent")), roles: parseRoles("assistant,user"), limit: limit, maxExcerptChars: 300}
	if a := strings.TrimSpace(vals.Get("author")); a != "" {
		p.roles = parseRoles(strings.ToLower(a))
		if len(p.roles) == 0 || (!p.roles["user"] && !p.roles["assistant"]) {
			return nil, false, func(w http.ResponseWriter) { errBadRequest(w, "author is user, assistant or both (user,assistant)") }
		}
	}
	if t, err := parseFlexibleTimestamp(since); err == nil {
		p.since = t
	}
	if t, err := parseFlexibleTimestamp(until); err == nil {
		p.until = t
	}
	matches, sessions, _, _, refused := h.historyMatches(r, sessionID, p, who, requested)
	if refused != nil {
		if named {
			return nil, false, refused
		}
		return nil, false, nil
	}
	if requested != store.SearchReachOwn {
		h.logSearchRead(r, who, requested, "ok", "history-search", strconv.Itoa(len(sessions))+" sessions", len(matches))
	}
	agents := map[string]string{}
	for _, it := range sessions {
		agents[it.SessionID] = it.AgentName
	}
	more := len(matches) > limit
	if more {
		matches = matches[:limit]
	}
	hits := make([]board.WorkHit, 0, len(matches))
	for _, m := range matches {
		at := m.Timestamp
		if t, err := parseFlexibleTimestamp(at); err == nil {
			at = t.UTC().Format("2006-01-02T15:04:05Z")
		}
		hits = append(hits, board.WorkHit{Source: "history", ID: int64(m.MessageIndex), Session: m.SessionID, Title: agents[m.SessionID], Snippet: m.Excerpt, State: m.Role, At: at})
	}
	return hits, more, nil
}

// truthyParam is a switch a request turns on with 1, true or yes.
func truthyParam(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
