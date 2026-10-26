package routes

// The cross-team artifact list (Goal #62): GET /api/team-artifacts, every team's artifacts in one list for the Inbox's Artifacts folder: the team route's query (q, kind, origin, by,
// board, kept, task, since, until, sort, limit, offset, cursor) plus team (repeatable, a team's id or name), the rows merged in one order under one cursor, each row naming its team
// (board_id, team). The same owner rule as the team route (the Operator's, or the owner through Coral Hub); GET /api/artifacts is the machine-wide store list and stays as it is.

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/subgentic/coral/internal/querypage"
)

// maxTeamArtifactTeams bounds the teams one read walks (each is a read of its task results and uploads); a person with more has the first of them by name, and the reply says it was cut.
const maxTeamArtifactTeams = 50

// maxTeamArtifactTeamFilter bounds the team names one request may give.
const maxTeamArtifactTeamFilter = 50

var allTeamArtifactParamNames = func() map[string]bool {
	m := map[string]bool{"team": true}
	for k, v := range teamArtifactParamNames {
		if k != "session_id" { // a session is one agent's list: the team route's
			m[k] = v
		}
	}
	return m
}()

// teamArtifactTeamRef is one team of the reply's teams list: the choices the Team filter offers, with what each holds before any filter.
type teamArtifactTeamRef struct {
	BoardID string `json:"board_id"`
	Team    string `json:"team"`
	All     int    `json:"all"`
}

// ListAllTeamArtifacts: GET /api/team-artifacts?team=&q=&kind=&origin=&by=&board=&kept=&task=&since=&until=&sort=&limit=&offset=&cursor=
func (h *BoardHandler) ListAllTeamArtifacts(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone, like the team route
		return
	}
	vals, perr := url.ParseQuery(r.URL.RawQuery)
	if perr != nil {
		errBadRequest(w, "the query string is not valid (no ';', and %-escapes must be two hex digits)")
		return
	}
	var unknown []string
	for k := range vals {
		if !allTeamArtifactParamNames[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		errBadRequest(w, "unknown parameter "+strings.Join(unknown, ", "))
		return
	}
	teams, err := taMulti("team", vals["team"], nil)
	if err != nil {
		errBadRequest(w, strings.TrimPrefix(err.Error(), errTeamArtifactQuery.Error()+": "))
		return
	}
	for _, t := range teams {
		if querypage.HasControl(t) {
			errBadRequest(w, "team can't contain a control character")
			return
		}
	}
	vals.Set(crossTeamScopeParam, "all")
	if _, ok := vals["sort"]; !ok { // the list is always a query: its cursor is tied to the filters and the sort
		vals.Set("sort", "newest")
	}
	tq, qerr := parseTeamArtifactQuery(vals)
	if qerr != nil {
		errBadRequest(w, strings.TrimPrefix(qerr.Error(), errTeamArtifactQuery.Error()+": "))
		return
	}
	limit, ok := parseBoundedInt(vals.Get("limit"), defaultTeamArtifactLimit, 1, maxTeamArtifactLimit)
	if !ok {
		errBadRequest(w, fmt.Sprintf("limit must be an integer between 1 and %d", maxTeamArtifactLimit))
		return
	}
	offset, ok := parseBoundedInt(vals.Get("offset"), 0, 0, maxTeamArtifactOffset)
	if !ok {
		errBadRequest(w, fmt.Sprintf("offset must be an integer between 0 and %d", maxTeamArtifactOffset))
		return
	}
	projects, err := h.bs.ListProjects(r.Context())
	if err != nil {
		errInternalServer(w, "could not list artifacts")
		return
	}
	wanted := map[string]bool{}
	for _, t := range teams {
		wanted[t] = true
	}
	var items []teamArtifact
	var refs []teamArtifactTeamRef
	truncated, cut := false, false
	walked := 0
	for _, p := range projects {
		label := p.BoardLabel
		if label == "" {
			label = p.Project
		}
		if len(teams) > 0 && !wanted[p.Project] && !wanted[label] {
			continue
		}
		if walked == maxTeamArtifactTeams {
			cut = true
			break
		}
		walked++
		rows, scanCut, err := h.projectArtifactItems(r, p.Project, "")
		if err != nil {
			errInternalServer(w, "could not list artifacts")
			return
		}
		truncated = truncated || scanCut
		for i := range rows {
			rows[i].BoardID, rows[i].Team = p.Project, label
		}
		if len(rows) > 0 {
			refs = append(refs, teamArtifactTeamRef{BoardID: p.Project, Team: label, All: len(rows)})
		}
		items = append(items, rows...)
	}
	all := len(items)
	sel, err := h.selectTeamArtifacts(r, items, limit, offset, tq)
	if err != nil {
		errInternalServer(w, "could not list artifacts")
		return
	}
	if refs == nil {
		refs = []teamArtifactTeamRef{}
	}
	resp := map[string]any{
		"artifacts": sel.page, "limit": limit, "offset": sel.start, "has_more": sel.hasMore, "truncated": truncated || cut,
		"total": sel.total, "all": all, "teams": refs,
	}
	if sel.next != "" {
		resp["next_cursor"] = sel.next
	}
	if len(sel.tags) > 0 {
		resp["tag_counts"] = sel.tags
	}
	writeJSON(w, http.StatusOK, resp)
}
