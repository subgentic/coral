package routes

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/store"
)

// How far an agent's chat search reaches (#11048): the level is on the agent's team member row, only the Operator raises it (PUT /api/team-members/{memberID}/search-access, an operator-only route), and every search above own is
// checked against the CALLER's own row. A teammate's level does not lend, and the level is not in anything an agent or a template can write.
const (
	// searchResponseCap bounds one search response (256 KiB of messages).
	searchResponseCap = 256 << 10
	searchPerMinute   = 30
	searchWindow      = time.Minute
	searchLogPruneN   = 50
)

// searchGuard is the per-member rate limit of searches above own (refusals included) and the pace of the access log's pruning. Its zero value is ready to use.
type searchGuard struct {
	mu   sync.Mutex
	hits map[string][]time.Time
	logs int
}

// allow counts one request of the member and says whether it is within the limit. The count is the member's (its team and agent name), not its token's, so a restart does not reset it.
func (g *searchGuard) allow(key string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.hits == nil {
		g.hits = map[string][]time.Time{}
	}
	now := time.Now()
	kept := g.hits[key][:0]
	for _, t := range g.hits[key] {
		if now.Sub(t) < searchWindow {
			kept = append(kept, t)
		}
	}
	if len(kept) >= searchPerMinute {
		g.hits[key] = kept
		return false
	}
	g.hits[key] = append(kept, now)
	if len(g.hits) > 1024 { // keys of members that stopped searching
		for k, v := range g.hits {
			if len(v) == 0 || now.Sub(v[len(v)-1]) >= searchWindow {
				delete(g.hits, k)
			}
		}
	}
	return true
}

func (g *searchGuard) pruneDue() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.logs++
	return g.logs%searchLogPruneN == 0
}

// searchCaller is who a search is for: the member row the caller's session is on, its level, its team (by row id) and the key its rate limit is counted under.
type searchCaller struct {
	key, team, agent, level string
	teamID                  int64
}

// searchWho reads the caller's member row once (the newest of its session) and trusts it only when the live row agrees on the team (team_id): a member row the live row does not confirm is "own", no team.
func (h *SessionsHandler) searchWho(r *http.Request, sessionID string) searchCaller {
	c := searchCaller{key: "session:" + sessionID, level: store.SearchReachOwn}
	if h.teamStore == nil || h.ss == nil {
		return c
	}
	m, err := h.teamStore.SearchMemberBySession(r.Context(), sessionID)
	if err != nil || m == nil {
		return c
	}
	ls, err := h.ss.GetLiveSession(r.Context(), sessionID)
	if err != nil || ls == nil || ls.TeamID == nil || *ls.TeamID != m.TeamID {
		return c
	}
	t, err := h.teamStore.GetTeamByID(r.Context(), m.TeamID)
	if err != nil || t == nil {
		return c
	}
	c.agent, c.level, c.teamID, c.team = m.AgentName, m.SearchReach, t.ID, t.Name
	c.key = "member:" + strconv.FormatInt(t.ID, 10) + "/" + m.AgentName
	return c
}

// searchBoards is the board set of a level, by board KEY, always an explicit set (never "every board"): own is the caller's launch board; team adds the launch boards of its team's members (the live rows' boards,
// joined by team_id: never the team's name); all is the boards of every team Coral launched; operator adds the boards no team owns (the Operator's own, ad hoc ones). A job's board and a relayed (remote)
// board are in no level but the caller's own.
func (h *SessionsHandler) searchBoards(r *http.Request, c searchCaller, launchKey, level string) ([]string, error) {
	ctx := r.Context()
	var more []string
	var err error
	switch level {
	case store.SearchReachTeam:
		if c.teamID > 0 {
			more, err = h.ss.TeamBoardKeys(ctx, c.teamID)
		}
	case store.SearchReachAll:
		more, err = h.ss.LaunchedTeamBoardKeys(ctx)
	case store.SearchReachOperator:
		more, err = h.bs.BoardKeys(ctx)
	}
	if err != nil {
		return nil, err
	}
	out := []string{launchKey}
	if len(more) == 0 {
		return out, nil
	}
	excluded, err := h.ss.JobAndRelayedBoardKeys(ctx)
	if err != nil {
		return nil, err
	}
	skip := map[string]bool{launchKey: true}
	for _, k := range excluded {
		skip[k] = true
	}
	for _, k := range more {
		if k != "" && !skip[k] {
			skip[k] = true
			out = append(out, k)
		}
	}
	return out, nil
}

// logSearchRead records a read above own: who, the level asked, the outcome, what it was and what it touched (board keys or a session id), and a count: never the query and never a result.
func (h *SessionsHandler) logSearchRead(r *http.Request, c searchCaller, requested, outcome, action, target string, results int) {
	if h.teamStore == nil {
		return
	}
	team := c.team
	if team == "" {
		team = "-"
	}
	agent := c.agent
	if agent == "" {
		agent = "-"
	}
	_ = h.teamStore.LogSearchRead(r.Context(), team, agent, requested, outcome, action, target, results)
	if h.searchRate.pruneDue() {
		_ = h.teamStore.PruneSearchAccess(r.Context())
	}
}

// SetMemberSearchAccess is PUT /api/team-members/{memberID}/search-access {"level": "own|team|all|operator", "confirm": "operator"}. The Operator's alone (operatorOnlyRoutes, and never through the
// Hub): the raise is logged in the same step. Setting "operator" needs "confirm": "operator", so the Operator's own CLI history is never reached by a slip of a control.
func (h *SessionsHandler) SetMemberSearchAccess(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Level   string `json:"level"`
		Confirm string `json:"confirm"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	level := strings.ToLower(strings.TrimSpace(body.Level))
	if store.SearchReachRank(level) < 0 {
		errBadRequest(w, "level must be own, team, all or operator")
		return
	}
	if level == store.SearchReachOperator && body.Confirm != "operator" {
		writeError(w, http.StatusBadRequest, "confirm_required", "Giving an agent the Operator's own CLI history needs confirm: \"operator\".")
		return
	}
	if h.teamStore == nil {
		errInternalServer(w, "teams are not available")
		return
	}
	memberID, err := strconv.ParseInt(chi.URLParam(r, "memberID"), 10, 64)
	if err != nil || memberID < 1 {
		errBadRequest(w, "memberID must be the member's id (members[].id of the team detail)")
		return
	}
	from, err := h.teamStore.SetSearchReach(r.Context(), memberID, level, "operator", "dashboard")
	if errors.Is(err, sql.ErrNoRows) {
		errNotFound(w, "that team has no such member")
		return
	}
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	_ = h.teamStore.PruneSearchAccess(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "member_id": memberID, "from": from, "level": level})
}

// SearchAccessLog is GET /api/search-access/log?limit=: the raises and the reads above own, newest first (no text). The Operator's.
func (h *SessionsHandler) SearchAccessLog(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000 {
			errBadRequest(w, "limit must be a whole number from 1 to 1000")
			return
		}
		limit = n
	}
	if h.teamStore == nil {
		errInternalServer(w, "teams are not available")
		return
	}
	rows, err := h.teamStore.ListSearchAccess(r.Context(), limit)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if rows == nil {
		rows = []store.SearchAccessRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rows})
}

// gateSearchReach is the check every agent search makes before it reads: the level asked (the reach parameter: none is own), the caller's own row, the per-member rate limit (a refusal counts), and a refusal
// that names the level needed. It has answered the request when ok is false.
func (h *SessionsHandler) gateSearchReach(w http.ResponseWriter, r *http.Request, sessionID string, vals url.Values) (c searchCaller, requested string, ok bool) {
	requested = strings.ToLower(strings.TrimSpace(vals.Get("reach")))
	if requested == "" {
		requested = store.SearchReachOwn
	}
	if store.SearchReachRank(requested) < 0 {
		errBadRequest(w, "reach must be own, team, all or operator")
		return c, requested, false
	}
	c = h.searchWho(r, sessionID)
	if requested != store.SearchReachOwn && !h.searchRate.allow(c.key) { // a search above own, or a refused one, is counted: a loop that probes the levels is slowed like one that reads; reads at own are the agent's own
		httputil.WriteActionLimit(w, 60, "search_rate_limited", "Too many searches from this agent: wait a minute and try again.")
		return c, requested, false
	}
	if store.SearchReachRank(requested) > store.SearchReachRank(c.level) {
		h.logSearchRead(r, c, requested, "refused", searchAction(r.URL.Path), "", 0)
		refuseSearchReach(w, c.level, requested)
		return c, requested, false
	}
	return c, requested, true
}

// historyReachSessions are the sessions a chat history search at a level reads, by session id: the caller's own lineage first, then (team) every session of its team's members and their ancestors, (all) every
// session Coral launched, (operator) also the sessions Coral only found on disk. Each other session is read as it is (a live one as a running session), never marked current.
func (h *SessionsHandler) historyReachSessions(ctx context.Context, sessionID string, c searchCaller, level string) ([]store.SessionLineageItem, bool, error) {
	ancestry, err := h.ss.GetSessionAncestry(ctx, sessionID)
	if err != nil {
		return nil, false, err
	}
	seen := map[string]bool{}
	out := make([]store.SessionLineageItem, 0, len(ancestry))
	for _, it := range ancestry {
		seen[it.SessionID] = true
		out = append(out, it)
	}
	truncated := false
	addLineage := func(ids []string) error {
		for _, id := range ids {
			if seen[id] {
				continue
			}
			if len(out) >= store.MaxReachSessions {
				truncated = true
				return nil
			}
			lin, err := h.ss.GetSessionAncestry(ctx, id)
			if err != nil {
				return err
			}
			for _, it := range lin {
				if seen[it.SessionID] {
					continue
				}
				if level != store.SearchReachOperator && !it.LiveRead {
					continue // team and all read what Coral has a live row for: an ancestor it only found on disk is the Operator's CLI history
				}
				seen[it.SessionID] = true
				it.IsCurrent = false // only the caller's own session is current
				out = append(out, it)
			}
		}
		return nil
	}
	switch level {
	case store.SearchReachTeam:
		if c.teamID > 0 {
			ids, err := h.ss.SessionIDsOfTeam(ctx, c.teamID)
			if err != nil {
				return nil, false, err
			}
			if err := addLineage(ids); err != nil {
				return nil, false, err
			}
		}
	case store.SearchReachAll, store.SearchReachOperator:
		ids, err := h.ss.LaunchedSessionIDs(ctx)
		if err != nil {
			return nil, false, err
		}
		if err := addLineage(ids); err != nil {
			return nil, false, err
		}
		if level == store.SearchReachOperator {
			items, err := h.ss.IndexedSessionItems(ctx)
			if err != nil {
				return nil, false, err
			}
			for _, it := range items {
				if !seen[it.SessionID] && len(out) < store.MaxReachSessions {
					seen[it.SessionID] = true
					out = append(out, it)
				}
			}
		}
	}
	return out, truncated, nil
}

// searchAction names a search endpoint for the access log.
func searchAction(path string) string {
	switch {
	case strings.HasSuffix(path, "/board/search"):
		return "board-search"
	case strings.HasSuffix(path, "/history/context"):
		return "history-context"
	}
	return "history-search"
}
