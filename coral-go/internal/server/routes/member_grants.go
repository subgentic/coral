package routes

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The Operator's grants to Hub people (#20387, G1-G6), the routes. A grant is written, listed and revoked by the person at this computer and by no one else: never through a Hub (the routes are `never`
// in the tunnel table and refused here again), never by an agent or an API key (humanInputCaller), and no field of a Hub's request is read. What it may be is bounded by the link: a grant never
// exceeds the cap of the link it names.

// memberLinkCap answers what cap an active link has, from the link store; nil until wired, which refuses every grant.
var memberLinkCap func(ctx context.Context, linkID string) (tunnel.Mode, bool)

// SetMemberLinkCap wires the link store's cap lookup.
func SetMemberLinkCap(f func(ctx context.Context, linkID string) (tunnel.Mode, bool)) {
	memberLinkCap = f
}

// memberOperatorOnly is the check every grant route starts with: a local call by a person, never one that came through a Hub and never automation.
func memberOperatorOnly(w http.ResponseWriter, r *http.Request) bool {
	if cloud.Tunneled(r) {
		errForbidden(w, "access for a Hub's people is changed at this computer, not through a Hub")
		return false
	}
	if !humanInputCaller(r) {
		errForbidden(w, "only the person at this computer can change who has access")
		return false
	}
	return true
}

const maxMemberGrantBody = 4 << 10

type memberGrantRequest struct {
	LinkID  string `json:"link_id"`
	HubUser string `json:"hub_user"`
	Level   string `json:"level"`
	Label   string `json:"label"`
	Days    int    `json:"days"`
}

// MemberGrants answers GET and POST /api/board/{project}/member-grants: the live grants of one team, and a new one.
func (h *BoardHandler) MemberGrants(w http.ResponseWriter, r *http.Request) {
	if !memberOperatorOnly(w, r) {
		return
	}
	project := urlParam(r, "project")
	if r.Method == http.MethodGet {
		gs, err := h.bs.ListMemberGrants(r.Context(), project, time.Now())
		if err != nil {
			errInternalServer(w, "could not read who has access")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"grants": gs})
		return
	}
	var in memberGrantRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxMemberGrantBody)
	if err := decodeJSONStrict(r, &in); err != nil {
		errBadRequest(w, `send {"link_id": "lnk-…", "hub_user": "hub-user-…", "level": "view" or "team", "label": "a name", "days": 7}`)
		return
	}
	if memberLinkCap == nil {
		errInternalServer(w, "Hub links are not available")
		return
	}
	capMode, ok := memberLinkCap(r.Context(), in.LinkID)
	if !ok {
		errBadRequest(w, "that Hub link is not linked to this computer")
		return
	}
	need := tunnel.TierView
	if in.Level == board.MemberLevelTeam {
		need = tunnel.TierInteract
	}
	if capMode < need {
		errBadRequest(w, "that link's access setting is lower than this level: raise the link's access first, or give less")
		return
	}
	g, err := h.bs.CreateMemberGrant(r.Context(), board.NewMemberGrant{LinkID: in.LinkID, HubUser: in.HubUser, BoardID: project, Level: in.Level, Label: in.Label, Days: in.Days})
	if err != nil {
		if errors.Is(err, board.ErrMemberGrant) {
			errBadRequest(w, memberReason(err))
			return
		}
		errInternalServer(w, "could not save the access")
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// memberReason is the plain sentence of a refused grant (the part after the closed prefix).
func memberReason(err error) string {
	if u, ok := err.(interface{ Unwrap() []error }); ok {
		if es := u.Unwrap(); len(es) > 1 {
			return es[len(es)-1].Error()
		}
	}
	return err.Error()
}

// RevokeMemberGrant answers DELETE /api/board/{project}/member-grants/{id}: access ends at once.
func (h *BoardHandler) RevokeMemberGrant(w http.ResponseWriter, r *http.Request) {
	if !memberOperatorOnly(w, r) {
		return
	}
	project := urlParam(r, "project")
	// The grant must be this team's: the list the path names is the scope of what it may end.
	gs, err := h.bs.ListMemberGrants(r.Context(), project, time.Now())
	if err != nil {
		errInternalServer(w, "could not read who has access")
		return
	}
	id := urlParam(r, "id")
	found := false
	for _, g := range gs {
		found = found || g.GrantID == id
	}
	if !found {
		errNotFound(w, "no one has that access to this team")
		return
	}
	g, err := h.bs.RevokeMemberGrant(r.Context(), id, time.Now())
	if err != nil {
		if errors.Is(err, board.ErrNoMemberGrant) {
			errNotFound(w, "no one has that access to this team")
			return
		}
		errInternalServer(w, "could not end the access")
		return
	}
	writeJSON(w, http.StatusOK, g)
}
