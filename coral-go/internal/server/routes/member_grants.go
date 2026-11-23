package routes

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
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

// memberOperatorOnly is the check every grant route starts with: a local call by a person, never automation, and never one that came through a Hub unless it is the owner's own device's signed request for
// one of the four routes the table lists once MemberRelayedOpen is true (#20883). A Hub's read of the lists is never allowed.
func memberOperatorOnly(w http.ResponseWriter, r *http.Request) bool {
	if cloud.Tunneled(r) {
		if r.Method != http.MethodGet && relayedGrantVerified(r) {
			return true
		}
		errForbidden(w, "access for a Hub's people is changed at this computer, or by the owner's own device signing the request")
		return false
	}
	if !humanInputCaller(r) {
		errForbidden(w, "only the person at this computer can change who has access")
		return false
	}
	return true
}

// relayedMemberVerify is memberVerify for a request that came through a Hub: the computer's device verifier (VerifyOwnerGrant), wired at startup. Nil refuses every relayed grant. The local check above is not
// changed by it: a local grant still needs memberVerify.
var relayedMemberVerify func(ctx context.Context, digest []byte, kid, sig string) (signerMode string, err error)

// SetRelayedMemberVerify wires the owner-device check for relayed grants.
func SetRelayedMemberVerify(f func(ctx context.Context, digest []byte, kid, sig string) (string, error)) {
	relayedMemberVerify = f
}

type relayedGrantKey struct{}

// relayedGrantVerified is the handler's own check that the guard verified this request as a grant-member one (the guard refuses an unsigned request first; this asks again, so removing either leaves the route
// refused): the gate is open, the verified message is of this kind, method and request URI, it names the link the request arrived on, and the body the handler will read is the body that was hashed. The body
// is read here, capped, and handed on as one slice, so the hashed, the checked and the parsed body are the same bytes.
func relayedGrantVerified(r *http.Request) bool {
	if !tunnel.MemberRelayedIsOpen() {
		return false
	}
	via, ok := cloud.ViaFrom(r.Context())
	if !ok || via.LinkID == "" {
		return false
	}
	m, ok := devicekey.RelayedFrom(r.Context())
	if !ok || m.Kind != devicekey.GrantMember || m.Method != r.Method || m.Path != r.URL.RequestURI() || m.Link != via.LinkID || m.HubUser != via.HubUser {
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxMemberGrantBody+1))
	if err != nil || len(raw) > maxMemberGrantBody || devicekey.BodySHA256(raw) != m.BodySHA256 {
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	*r = *r.WithContext(context.WithValue(r.Context(), relayedGrantKey{}, m))
	return true
}

// relayedGrant is the verified message of a request that passed relayedGrantVerified; ok is false for a local one.
func relayedGrant(r *http.Request) (devicekey.Relayed, bool) {
	m, ok := r.Context().Value(relayedGrantKey{}).(devicekey.Relayed)
	return m, ok
}

const maxMemberGrantBody = 4 << 10

// memberGrantWindow is how far from this computer's clock a signed grant's time may be.
const memberGrantWindow = 5 * time.Minute

// memberVerify checks that kid is a device of this computer's owner and that sig is its signature over the grant's digest (board.MemberGrantDigest): the Hub half of the signed `grant-member` message and the
// owner-pair check (B2) are what make it. Nil until they exist, which refuses every grant: no grant is written without it, and nothing here accepts a signature it did not check.
var memberVerify func(ctx context.Context, digest []byte, kid, sig string) (signerMode string, err error)

// SetMemberVerify wires the owner-device signature check.
func SetMemberVerify(f func(ctx context.Context, digest []byte, kid, sig string) (string, error)) {
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
	if memberLinkCap == nil || (memberVerify == nil && !isRelayedRequest(r)) {
		writeError(w, http.StatusServiceUnavailable, "grants_unavailable", "giving a Hub person access is not available yet")
		return
	}
	relayed, isRelayed := relayedGrant(r)
	if isRelayed && (in.LinkID != relayed.Link || relayedMemberVerify == nil) {
		// A grant given through one link names that link only (#20838): another link, or none, is the same answer as a link that is not here, so a Hub learns nothing about its neighbours.
		if relayedMemberVerify == nil {
			writeError(w, http.StatusServiceUnavailable, "grants_unavailable", "giving a Hub person access is not available yet")
			return
		}
		errBadRequest(w, "that Hub link is not linked to this computer")
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
	// The signature is checked before anything is written; the store checks the rest and spends the nonce.
	verify := memberVerify
	if isRelayed {
		verify = relayedMemberVerify
	}
	signerMode, err := verify(r.Context(), board.MemberGrantDigest(ng), in.Signature.KID, in.Signature.Sig)
	if err != nil {
		errForbidden(w, "that is not the signature of one of your own devices")
		return
	}
	// A grant is never more than the device that signed it could do (#20883): the level is bounded by the signer's own mode, read from the computer's device list, as well as by the link's cap.
	if isRelayed && memberSignerMode(signerMode) < need {
		errForbidden(w, "that device's access setting is lower than this level: sign with a device that has it, or give less")
		return
	}
	// A full grant is a shell on this computer: only a device at the top mode (launch) can sign one. The mode is read from the computer's own device list by the verifier, never from the request.
	if in.Level == board.MemberLevelFull && signerMode != "launch" {
		errForbidden(w, "giving full access needs a device with launch access: sign with one")
		return
	}
	if d := time.Since(time.Unix(ng.Ts, 0)); d > memberGrantWindow || d < -memberGrantWindow {
		errBadRequest(w, "the signature is too old or too new: sign it again")
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
	if isRelayed {
		h.noteRelayedGrant(r, "gave", g)
	}
	writeJSON(w, http.StatusOK, g)
}

// isRelayedRequest reports whether the handler took this request as a verified relayed one.
func isRelayedRequest(r *http.Request) bool { _, ok := relayedGrant(r); return ok }

// memberSignerMode is the tunnel mode a device's stored mode names; an unknown word is the lowest.
func memberSignerMode(s string) tunnel.Mode {
	if m, ok := tunnel.ParseMode(s); ok {
		return m
	}
	return tunnel.TierView
}

// noteRelayedGrant leaves what a Hub's grant or revoke did where the Operator will see it (#20883, #20838): a row of the Operator-actions log naming the link, the person and the grant, and a notice on the team's
// own board, in words Coral wrote from values it checked (the person's label is cleaned and cut). The notice is information, not an approval; ending the access is done from this computer's access list.
func (h *BoardHandler) noteRelayedGrant(r *http.Request, verb string, g *board.MemberGrant) {
	id := hubOwnerRequest(r)
	recordHubOwnerAction(r.Context(), h.bs, id, r.Method, fmt.Sprintf("%s grant=%s level=%s scope=%s", r.URL.Path, g.GrantID, g.Level, g.ScopeKind), g.BoardID, http.StatusOK)
	if g.BoardID == "" {
		return
	}
	who := board.CleanMemberLabel(g.Label)
	who = capRunes(who, 40)
	text := fmt.Sprintf("Through Coral Hub, your device %s %s %s (%s) %s access to this team until %s. End it from this computer's access list.", shortKID(g.SignedBy), verb, who, g.HubUser, g.Level, g.ExpiresAt)
	if verb == "ended" {
		text = fmt.Sprintf("Through Coral Hub, your device %s ended %s's (%s) %s access to this team.", shortKID(g.SignedBy), who, g.HubUser, g.Level)
	}
	if _, err := h.bs.PostHubNotice(r.Context(), g.BoardID, text); err != nil {
		slog.Warn("[member] could not post the notice of a relayed grant", "error", err)
	}
}

// capRunes cuts s to at most n characters (not bytes), so a multi-byte name is never split.
func capRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func shortKID(k string) string {
	if len(k) > 8 {
		return k[:8]
	}
	return k
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
	relayed, isRelayed := relayedGrant(r)
	for _, g := range gs {
		// Through a Hub a grant is the arrival link's own to end: another link's is as missing as one that is not here (the same 404), so a Hub cannot probe its neighbours.
		found = found || (g.GrantID == id && (!isRelayed || g.LinkID == relayed.Link))
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
	if isRelayed {
		h.noteRelayedGrant(r, "ended", g)
	}
	writeJSON(w, http.StatusOK, g)
}
