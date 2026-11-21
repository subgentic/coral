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

// memberGrantWindow is how far from this computer's clock a signed grant's time may be.
const memberGrantWindow = 5 * time.Minute

// memberVerify checks that kid is a device of this computer's owner and that sig is its signature over the grant's digest (board.MemberGrantDigest): the Hub half of the signed `grant-member` message and the
// owner-pair check (B2) are what make it. Nil until they exist, which refuses every grant: no grant is written without it, and nothing here accepts a signature it did not check.
var memberVerify func(ctx context.Context, digest []byte, kid, sig string) error

// SetMemberVerify wires the owner-device signature check.
func SetMemberVerify(f func(ctx context.Context, digest []byte, kid, sig string) error) {
	memberVerify = f
}

type memberGrantRequest struct {
	LinkID       string `json:"link_id"`
	HubUser      string `json:"hub_user"`
	Level        string `json:"level"`
	ScopeKind    string `json:"scope_kind"`
	ScopeID      string `json:"scope_id"`
	Artifacts    bool   `json:"artifacts"`
	Files        bool   `json:"files"`
	PinnedFolder string `json:"pinned_folder"`
	Label        string `json:"label"`
	Days         int    `json:"days"`
	Signature    struct {
		KID   string `json:"kid"`
		Nonce string `json:"nonce"`
		Ts    int64  `json:"ts"`
		Sig   string `json:"sig"`
	} `json:"signature"`
}

// MemberGrants answers GET and POST /api/board/{project}/member-grants: the live grants of one team, and a new view grant for the team or one of its agents.
func (h *BoardHandler) MemberGrants(w http.ResponseWriter, r *http.Request) {
	if !memberOperatorOnly(w, r) {
		return
	}
	project := urlParam(r, "project")
	if r.Method == http.MethodGet {
		h.listMemberGrants(w, r, project)
		return
	}
	h.createMemberGrant(w, r, project)
}

// ComputerMemberGrants answers GET and POST /api/member-grants: every live grant of this computer, and a new full one.
func (h *BoardHandler) ComputerMemberGrants(w http.ResponseWriter, r *http.Request) {
	if !memberOperatorOnly(w, r) {
		return
	}
	if r.Method == http.MethodGet {
		h.listMemberGrants(w, r, "")
		return
	}
	h.createMemberGrant(w, r, "")
}

func (h *BoardHandler) listMemberGrants(w http.ResponseWriter, r *http.Request, project string) {
	gs, err := h.bs.ListMemberGrants(r.Context(), project, time.Now())
	if err != nil {
		errInternalServer(w, "could not read who has access")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"grants": gs})
}

// createMemberGrant writes one signed grant. project is the team the path names ("" on the computer's route, which takes only a full grant): a team's route can give only that team (or its agents), and a
// field of the body never names another one.
func (h *BoardHandler) createMemberGrant(w http.ResponseWriter, r *http.Request, project string) {
	var in memberGrantRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxMemberGrantBody)
	if err := decodeJSONStrict(r, &in); err != nil {
		errBadRequest(w, `send {"link_id": "lnk-…", "hub_user": "hub-user-…", "level": "view" or "full", "scope_kind": "board", "label": "a name", "days": 7, "signature": {…}}`)
		return
	}
	if memberLinkCap == nil || memberVerify == nil {
		writeError(w, http.StatusServiceUnavailable, "grants_unavailable", "giving a Hub person access is not available yet")
		return
	}
	capMode, ok := memberLinkCap(r.Context(), in.LinkID)
	if !ok {
		errBadRequest(w, "that Hub link is not linked to this computer")
		return
	}
	need := tunnel.TierView
	if in.Level == board.MemberLevelFull {
		need = tunnel.TierInteract // full is the link's cap and no more: a link that cannot interact has nothing to give
	}
	if capMode < need {
		errBadRequest(w, "that link's access setting is lower than this level: raise the link's access first, or give less")
		return
	}
	ng := board.NewMemberGrant{LinkID: in.LinkID, HubUser: in.HubUser, Level: in.Level, ScopeKind: in.ScopeKind, ScopeID: in.ScopeID, FlagArtifacts: in.Artifacts, FlagFiles: in.Files,
		PinnedFolder: in.PinnedFolder, Label: in.Label, Days: in.Days, SignedBy: in.Signature.KID, Nonce: in.Signature.Nonce, Ts: in.Signature.Ts}
	switch {
	case project != "":
		if in.Level == board.MemberLevelFull || in.ScopeKind == board.MemberScopeComputer {
			errBadRequest(w, "full access is given on the computer's own list, not on a team's")
			return
		}
		ng.BoardID = project // the team the request is made on; for the team's own scope the id is the team
		if in.ScopeKind == board.MemberScopeBoard {
			ng.ScopeID = project
		}
	default:
		if in.Level != board.MemberLevelFull {
			errBadRequest(w, "give a team's or an agent's access on that team")
			return
		}
	}
	if d := time.Since(time.Unix(ng.Ts, 0)); d > memberGrantWindow || d < -memberGrantWindow {
		errBadRequest(w, "the signature is too old or too new: sign it again")
		return
	}
	// The signature is checked before anything is written; the store checks the rest and spends the nonce.
	if err := memberVerify(r.Context(), board.MemberGrantDigest(ng), in.Signature.KID, in.Signature.Sig); err != nil {
		errForbidden(w, "that is not the signature of one of your own devices")
		return
	}
	g, err := h.bs.CreateMemberGrant(r.Context(), ng)
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
	// On a team's route (project set) only that team's grants can be ended; on the computer's route (project empty) any of the computer's.
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
		errNotFound(w, "no one has that access here")
		return
	}
	g, err := h.bs.RevokeMemberGrant(r.Context(), id, time.Now())
	if err != nil {
		if errors.Is(err, board.ErrNoMemberGrant) {
			errNotFound(w, "no one has that access here")
			return
		}
		errInternalServer(w, "could not end the access")
		return
	}
	writeJSON(w, http.StatusOK, g)
}
