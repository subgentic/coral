package routes

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/store"
)

// How far an agent's chat search reaches (#11048): the level is on the agent's team member row, only the Operator raises it (PUT .../search-access, an operator-only route), and every search above own is
// checked against the CALLER's own row. A teammate's level does not lend, and the level is not in anything an agent or a template can write.
const (
	// searchResponseCap bounds one search response (256 KiB of messages).
	searchResponseCap = 256 << 10
	searchPerMinute   = 30
	searchWindow      = time.Minute
	searchLogPruneN   = 50
)

// searchGuard is the per-member rate limit and the pace of the access log's pruning. Its zero value is ready to use.
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

// searchCaller is who a search is for: the member row the caller's session is on, its level, and the key its rate limit is counted under.
type searchCaller struct {
	key, team, agent, level, teamName string
}

func (h *SessionsHandler) searchWho(r *http.Request, sessionID string) searchCaller {
	c := searchCaller{key: "session:" + sessionID, level: store.SearchReachOwn}
	if h.teamStore == nil {
		return c
	}
	m, err := h.teamStore.GetMemberBySessionID(r.Context(), sessionID)
	if err != nil || m == nil {
		return c
	}
	c.agent = m.AgentName
	if store.SearchReachRank(m.SearchReach) >= 0 {
		c.level = m.SearchReach
	}
	if t, err := h.teamStore.GetTeamByID(r.Context(), m.TeamID); err == nil && t != nil {
		c.team, c.teamName = t.Name, t.Name
		c.key = "member:" + t.Name + "/" + m.AgentName
	}
	return c
}

// searchBoards is the board set of a level, by key: own is the one launch board (nil, false: the query's Project), team adds the boards of the caller's team, all and operator are every board.
func (h *SessionsHandler) searchBoards(r *http.Request, c searchCaller, launchKey, level string) ([]string, bool) {
	switch level {
	case store.SearchReachTeam:
		set := []string{launchKey}
		if c.teamName != "" && c.teamName != launchKey {
			set = append(set, c.teamName)
		}
		return set, false
	case store.SearchReachAll, store.SearchReachOperator:
		return nil, true
	}
	return nil, false
}

// logSearchRead records a search above own (who, the level asked, the outcome, a count): never the query and never a result.
func (h *SessionsHandler) logSearchRead(r *http.Request, c searchCaller, requested, outcome string, results int) {
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
	_ = h.teamStore.LogSearchRead(r.Context(), team, agent, requested, outcome, results)
	if h.searchRate.pruneDue() {
		_ = h.teamStore.PruneSearchAccess(r.Context())
	}
}

// SetMemberSearchAccess is PUT /api/teams/detail/{name}/members/{agent}/search-access {"level": "own|team|all|operator", "confirm": "operator"}. The Operator's alone (operatorOnlyRoutes, and never through the
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
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "level must be own, team, all or operator", "field": "level"})
		return
	}
	if level == store.SearchReachOperator && body.Confirm != "operator" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Giving an agent the Operator's own CLI history needs confirm: \"operator\".", "code": "confirm_required", "field": "confirm"})
		return
	}
	if h.teamStore == nil {
		errInternalServer(w, "teams are not available")
		return
	}
	team, agent := chi.URLParam(r, "name"), chi.URLParam(r, "agent")
	from, err := h.teamStore.SetSearchReach(r.Context(), team, agent, level, "operator", "dashboard")
	if errors.Is(err, sql.ErrNoRows) {
		errNotFound(w, "that team has no such member")
		return
	}
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	_ = h.teamStore.PruneSearchAccess(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "team": team, "agent": agent, "from": from, "level": level})
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
