package routes

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/httputil"
)

// Links between teams of this computer (#9893, the design note of #9875): the Operator's command-line and API way to say which of this computer's teams may message which. A link is an entry on
// the TARGET team's list of who may message it (cross_team_allowed, the list the settings route and the dashboard already edit), so one list is the truth. "A may message B" is the entry on B naming A;
// both ways (the default, the operator's choice) writes both entries in one transaction. The Operator on this computer only, never an agent token and never through Coral Hub (the owner edits the
// list through the settings route, as before). Whether the list is ENFORCED is the global switch cross_team_allowlist, off until the Operator turns it on: until then a link is recorded and counted.

// localLinkBody is the body of POST and DELETE /api/board/{project}/cross-team-links: with names the other team (its name or id); both (default true) links or unlinks both ways, false only
// "{project} may message with"; files (POST, default true) is the link's files grant.
type localLinkBody struct {
	With  string `json:"with"`
	Both  *bool  `json:"both,omitempty"`
	Files *bool  `json:"files,omitempty"`
}

// localLinkEnd is one team on a link, as the Operator reads it.
type localLinkEnd struct {
	Board       string `json:"board"`
	Label       string `json:"label"`
	CrossTeamID string `json:"cross_team_id"`
	Files       bool   `json:"files"`
}

// linkTeams resolves a team's key to its id, label and cross-team id; ok false when it is not a team of this computer with a cross-team id.
func (h *BoardHandler) linkTeam(ctx context.Context, key string) (id, label, crossID string, ok bool) {
	exists, err := h.bs.BoardExists(ctx, key)
	if err != nil || !exists {
		return "", "", "", false
	}
	crossID, has := h.senderIDOf(ctx, key)
	if !has {
		return "", "", "", false
	}
	label = key
	if b, err := h.bs.GetBoard(ctx, key); err == nil && b.Label != "" {
		label = b.Label
	}
	return key, label, crossID, true
}

// linkState is the links of one team: who may message it (its own list's local entries) and whom it may message (the other teams' lists that name it), and whether any of it is enforced.
func (h *BoardHandler) linkState(ctx context.Context, team string) (map[string]any, error) {
	id, label, crossID, ok := h.linkTeam(ctx, team)
	if !ok {
		return nil, board.ErrBoardNotFound
	}
	settings, err := h.bs.GetBoardSettings(ctx, id)
	if err != nil {
		return nil, err
	}
	may := []localLinkEnd{}
	otherEntries := 0
	for _, e := range settings.CrossTeamAllowed {
		if e.Server != board.LocalServer {
			otherEntries++
			continue
		}
		end := localLinkEnd{CrossTeamID: e.CrossTeamID, Label: e.Label, Files: e.Files == nil || *e.Files}
		if key, lbl, found, err := h.bs.BoardByCrossTeamID(ctx, e.CrossTeamID); err == nil && found {
			end.Board, end.Label = key, lbl
		}
		may = append(may, end)
	}
	listing, err := h.bs.BoardsListing(ctx, crossID)
	if err != nil {
		return nil, err
	}
	toward := []localLinkEnd{}
	for _, l := range listing {
		_, lbl, tid, ok := h.linkTeam(ctx, l.Target)
		if !ok {
			continue
		}
		toward = append(toward, localLinkEnd{Board: l.Target, Label: lbl, CrossTeamID: tid, Files: l.Files == nil || *l.Files})
	}
	return map[string]any{
		"team":                  localLinkEnd{Board: id, Label: label, CrossTeamID: crossID, Files: true},
		"may_message_this_team": may,
		"this_team_may_message": toward,
		"through_coral_hub":     otherEntries, // entries of another Coral's teams on this team's list: not edited here
		"enforced":              h.allowlistOn(ctx),
	}, nil
}

// ListLocalLinks: GET /api/board/{project}/cross-team-links.
func (h *BoardHandler) ListLocalLinks(w http.ResponseWriter, r *http.Request) {
	if !h.requireListOwner(w, r) {
		return
	}
	state, err := h.linkState(r.Context(), urlParam(r, "project"))
	if errors.Is(err, board.ErrBoardNotFound) {
		errNotFound(w, "that team does not exist, or has no cross-team id")
		return
	}
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, state)
}

// AddLocalLinks: POST /api/board/{project}/cross-team-links {"with": "<team>", "both": true, "files": true}.
func (h *BoardHandler) AddLocalLinks(w http.ResponseWriter, r *http.Request) {
	h.editLocalLinks(w, r, false)
}

// RemoveLocalLinks: DELETE /api/board/{project}/cross-team-links {"with": "<team>", "both": true}.
func (h *BoardHandler) RemoveLocalLinks(w http.ResponseWriter, r *http.Request) {
	h.editLocalLinks(w, r, true)
}

func (h *BoardHandler) editLocalLinks(w http.ResponseWriter, r *http.Request, remove bool) {
	if !h.requireListOwner(w, r) {
		return
	}
	var body localLinkBody
	if err := decodeJSON(r, &body); err != nil || body.With == "" {
		errBadRequest(w, `with is required: {"with": "<team>"}`)
		return
	}
	ctx := r.Context()
	team, teamLabel, teamID, ok := h.linkTeam(ctx, urlParam(r, "project"))
	if !ok {
		errNotFound(w, "that team does not exist, or has no cross-team id")
		return
	}
	otherKey, candidates, err := resolveBoard(r, h.bs, body.With)
	if errors.Is(err, board.ErrAmbiguousBoard) {
		writeError(w, http.StatusConflict, "ambiguous_board", fmt.Sprintf("%d teams are named that: use the team's id (coral-board projects lists them)", len(candidates)))
		return
	}
	if err != nil {
		errNotFound(w, "no team of this computer is named that")
		return
	}
	other, otherLabel, otherID, ok := h.linkTeam(ctx, otherKey)
	if !ok {
		errNotFound(w, "no team of this computer is named that")
		return
	}
	if other == team {
		errBadRequest(w, "a team is not linked to itself")
		return
	}
	both := body.Both == nil || *body.Both
	files := true
	if body.Files != nil {
		files = *body.Files
	}
	// "team may message other" is the entry on other naming team; both adds "other may message team" on team.
	senderOf := func(label, id string) board.AllowedSender {
		s := board.AllowedSender{CrossTeamID: id, Label: label}
		if !remove {
			f := files
			s.Files = &f
		}
		return s
	}
	edits := []board.LocalLinkEdit{{Target: other, Sender: senderOf(teamLabel, teamID), Remove: remove}}
	if both {
		edits = append(edits, board.LocalLinkEdit{Target: team, Sender: senderOf(otherLabel, otherID), Remove: remove})
	}
	if !h.allowEditSlot(callerActor(r)) {
		httputil.WriteActionLimit(w, 0, "edit_rate_limited", "too many edits of who may message a team in the last hour; try again later")
		return
	}
	changes, err := h.bs.ApplyLocalLinks(ctx, edits, map[string]string{team: teamID, other: otherID})
	if errors.Is(err, board.ErrLinkListFull) {
		writeError(w, http.StatusConflict, "list_full", fmt.Sprintf("a team's list holds at most %d senders", board.MaxAllowedSenders))
		return
	}
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	actor := callerActor(r).Name
	if actor == "" {
		actor = crossTeamOperatorID
	}
	for _, c := range changes { // every change is audited by id, as the settings route's list edits are
		if err := h.bs.AppendEditLog(context.WithoutCancel(ctx), c.Target, actor, "cross_team_allowed", allowedForLog(c.Before), allowedForLog(c.After)); err != nil {
			slog.Warn("cross-team: could not log a link edit", "board", c.Target, "error", err)
		}
	}
	state, err := h.linkState(ctx, team)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	state["changed"] = len(changes)
	writeJSON(w, http.StatusOK, state)
}
