package routes

import (
	"context"
	"errors"
	"log/slog"
	"math/rand"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/safego"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// RevokeAnswer is what the Hub said to this computer's "remove me" call (design v2, slice 2; the call is coral-hub's #20354).
type RevokeAnswer int

const (
	RevokeUnsupported  RevokeAnswer = iota // the Hub has no such call yet: finish here and say so
	RevokeRemoved                          // 200 removed
	RevokeAlreadyGone                      // 200 already_gone
	RevokeNotFound                         // 404: the Hub does not know this computer
	RevokeTokenRefused                     // 401: the Hub does not accept this link's token, so it is useless here
	RevokeForbidden                        // 403: keep removing, retry
	RevokeRetry                            // 429, 5xx, timeout: keep removing, retry
	RevokeBadRequest                       // 400: our own bug: no retry, the Operator is told
)

// HubRevoker asks one Hub to remove this computer. It sends the sealed token only to the stored origin, with TLS verified, no redirects, a 10 s timeout and an answer read to 1 KB, and never logs it.
type HubRevoker interface {
	Revoke(ctx context.Context, origin, serverID, token string) RevokeResult
}

// SetLinkStore sets where the links are kept (the server's own store) and SetLinkRevoker the Hub call; until the Hub's call exists the default says the Hub still lists this computer.
func (h *CloudHandler) SetLinkStore(cs *store.CloudStore) {
	h.links = cs
	linkOriginOf = func(ctx context.Context, id string) string {
		if ls, err := cs.ListLinks(ctx); err == nil {
			for _, l := range ls {
				if l.LinkID == id {
					return l.HubOrigin
				}
			}
		}
		return ""
	}
}
func (h *CloudHandler) SetLinkRevoker(r HubRevoker) { h.revoker = r }

// hubRevokeSetting switches the real Hub call on: off by default, and nothing in Coral's routes, flags or environment sets it; it is turned on after a joint real run with coral-hub and the Operator's yes.
const hubRevokeSetting = setreg.HubRevokeCall

func (h *CloudHandler) hubRevokeOn() bool {
	set, err := h.ss.GetSettings(context.Background())
	return err == nil && set[hubRevokeSetting] == "on"
}

const (
	msgHubStillLists   = "the Hub still lists this computer"
	msgHubTokenRefused = "the Hub did not accept this computer's token; if it still lists this computer, remove it there"
)

// linkView is the safe view of one link: never a token, an account or anyone's hub-user.
type linkView struct {
	LinkID    string  `json:"link_id"`
	HubOrigin string  `json:"hub_origin"`
	Label     string  `json:"label"`
	State     string  `json:"state"`
	MaxMode   string  `json:"max_mode"`
	CreatedAt string  `json:"created_at"`
	LastSeen  *string `json:"last_seen"`
	LastError *string `json:"last_error"`
}

func (h *CloudHandler) linkList(ctx context.Context) ([]linkView, error) {
	ls, err := h.links.ListLinks(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]linkView, 0, len(ls))
	for _, l := range ls {
		out = append(out, linkView{l.LinkID, l.HubOrigin, l.Label, l.State, l.MaxMode, l.CreatedAt, l.LastSeen, l.LastError})
	}
	return out, nil
}

func (h *CloudHandler) linkAction(ctx context.Context, id, action, detail string) {
	if l, err := h.links.ListLinks(ctx); err == nil {
		for _, x := range l {
			if x.LinkID == id {
				slog.Info("cloud: link "+action, "link", id, "hub", x.HubOrigin, "detail", detail)
			}
		}
	}
}

// Links: GET /api/cloud/links. The person at this computer only (never tunneled).
func (h *CloudHandler) Links(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || h.noLinkStore(w) {
		return
	}
	out, err := h.linkList(r.Context())
	if err != nil {
		errInternalServer(w, "Could not read the Hub links")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": out, "max_links": store.MaxCloudLinks, "adding": h.addingList()})
}

func (h *CloudHandler) noLinkStore(w http.ResponseWriter) bool {
	if h.links == nil {
		errInternalServer(w, "Hub links are not available")
		return true
	}
	return false
}

// addingView is one Hub being added, as the person sees it: text only (the Hub's words go through cleanSavedField), never the device code or a token.
type addingView struct {
	Hub             string `json:"hub"`
	Cap             string `json:"cap"`
	State           string `json:"state"`
	UserCode        string `json:"user_code,omitempty"`
	VerificationURL string `json:"verification_url,omitempty"`
	Note            string `json:"note,omitempty"`
	Message         string `json:"message,omitempty"`
	ExpiresAt       string `json:"expires_at,omitempty"`
	OwnerCandidate  string `json:"owner_candidate,omitempty"` // the Hub person this Hub named as its owner, for the Operator to confirm (#20407)
}

func viewOfEnrollment(e cloud.LinkEnrollment) addingView {
	v := addingView{Hub: e.Origin, Cap: e.Cap, State: e.State, UserCode: cleanSavedField(e.UserCode), VerificationURL: cleanSavedField(e.VerificationURL),
		Note: cleanSavedField(e.Note), Message: cleanSavedField(e.Message), OwnerCandidate: cleanSavedField(e.OwnerCandidate)}
	if !e.ExpiresAt.IsZero() {
		v.ExpiresAt = e.ExpiresAt.UTC().Format(time.RFC3339)
	}
	return v
}

func (h *CloudHandler) addingList() []addingView {
	out := []addingView{}
	if m := h.manager(); m != nil {
		for _, e := range m.LinkEnrollments() {
			out = append(out, viewOfEnrollment(e))
		}
	}
	return out
}

// AddLink: POST /api/cloud/links {"hub": address, "cap": "view"|"interact"|"launch"}. The person at this computer adds another Hub: Coral asks that Hub for a code and the person approves it there; nothing is stored
// before that (#20385). The cap is chosen out loud, with no default. Refused first, before the Hub is asked: a bad address or cap, a Hub already linked, the switch still off and the cap on links. Never tunneled, never an agent's.
func (h *CloudHandler) AddLink(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) || h.noLinkStore(w) {
		return
	}
	var body struct {
		Hub string `json:"hub"`
		Cap string `json:"cap"`
	}
	if err := decodeJSONLimit(r, &body, 4096); err != nil {
		errBadRequest(w, "send {\"hub\": the Hub's address, \"cap\": \"view\", \"interact\" or \"launch\"}")
		return
	}
	// The switch and the cap on links are the store's to answer, with or without a connector.
	switch cerr := h.links.CheckCanAddLink(r.Context()); {
	case errors.Is(cerr, store.ErrSecondLinkNotYet):
		writeError(w, http.StatusConflict, "second_link_not_yet", "This Coral links to one Hub for now. Remove that link first.")
		return
	case errors.Is(cerr, store.ErrTooManyLinks):
		writeError(w, http.StatusConflict, "too_many_links", "This computer is linked to the most Hubs it can be.")
		return
	case cerr != nil:
		errInternalServer(w, "Could not check the Hub links")
		return
	}
	m := h.manager()
	if m == nil {
		errInternalServer(w, "The Coral Hub connector is not available")
		return
	}
	pe, err := m.AddLinkByOrigin(r.Context(), body.Hub, body.Cap)
	var rl *cloud.RateLimitedError
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]any{"enrollment": viewOfEnrollment(*pe)})
	case errors.Is(err, store.ErrLinkExists):
		writeError(w, http.StatusConflict, "already_linked", store.ErrLinkExists.Error())
	case errors.Is(err, store.ErrSecondLinkNotYet):
		writeError(w, http.StatusConflict, "second_link_not_yet", "This Coral links to one Hub for now. Remove that link first.")
	case errors.Is(err, store.ErrTooManyLinks):
		writeError(w, http.StatusConflict, "too_many_links", "This computer is linked to the most Hubs it can be.")
	case errors.As(err, &rl):
		httputil.WriteActionLimit(w, 0, "rate_limited", "That Hub is busy. Try again in a moment.")
	case errors.Is(err, cloud.ErrHubUnavailable), errors.Is(err, cloud.ErrHubResponse):
		writeError(w, http.StatusBadGateway, "hub_unreachable", "Coral could not get a code from that Hub. Check the address and try again.")
	case errors.Is(err, cloud.ErrNotConfigured):
		errInternalServer(w, "The Coral Hub connector is not available")
	default:
		errBadRequest(w, cleanSavedField(err.Error())) // an address or cap that is not valid, or a Hub that needs Connect: our own words
	}
}

// CancelLinkEnrollment: POST /api/cloud/links/cancel {"hub": address}. Ends the Hub being added: an approval that comes later links nothing.
func (h *CloudHandler) CancelLinkEnrollment(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) || h.noLinkStore(w) {
		return
	}
	var body struct {
		Hub string `json:"hub"`
	}
	if err := decodeJSONLimit(r, &body, 4096); err != nil {
		errBadRequest(w, `send {"hub": the Hub's address}`)
		return
	}
	origin, err := store.CanonicalHubOrigin(body.Hub)
	if err != nil {
		errBadRequest(w, "That is not a Hub address")
		return
	}
	cancelled := false
	if m := h.manager(); m != nil {
		cancelled = m.CancelLinkEnrollment(origin)
	}
	writeJSON(w, http.StatusOK, map[string]any{"cancelled": cancelled, "adding": h.addingList()})
}

// ConfirmLinkOwner: POST /api/cloud/links/confirm-owner {"hub": address, "candidate": the Hub person shown}. The Operator, at this computer, says the person the Hub named is this link's owner (#20407). The candidate in the
// request must be exactly the one this computer holds for that Hub: the owner is never taken from the request. Never tunneled, never an agent's.
func (h *CloudHandler) ConfirmLinkOwner(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) || h.noLinkStore(w) {
		return
	}
	var body struct {
		Hub       string `json:"hub"`
		Candidate string `json:"candidate"`
	}
	if err := decodeJSONLimit(r, &body, 4096); err != nil || body.Candidate == "" {
		errBadRequest(w, `send {"hub": the Hub's address, "candidate": the name the Hub gave}`)
		return
	}
	origin, err := store.CanonicalHubOrigin(body.Hub)
	if err != nil {
		errBadRequest(w, "That is not a Hub address")
		return
	}
	m := h.manager()
	if m == nil {
		errInternalServer(w, "The Coral Hub connector is not available")
		return
	}
	switch err := m.ConfirmLinkOwner(r.Context(), origin, body.Candidate); {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]any{"confirmed": true, "adding": h.addingList()})
	case errors.Is(err, cloud.ErrNoOwnerCandidate):
		writeError(w, http.StatusConflict, "no_owner_candidate", err.Error())
	case errors.Is(err, cloud.ErrOwnerCandidateMismatch):
		writeError(w, http.StatusConflict, "owner_candidate_mismatch", err.Error())
	case errors.Is(err, store.ErrOwnerAlreadyConfirmed):
		writeError(w, http.StatusConflict, "owner_already_confirmed", err.Error())
	case errors.Is(err, store.ErrNoCloudLink), errors.Is(err, store.ErrBadLinkState):
		errNotFound(w, "No Hub added at that address")
	default:
		errInternalServer(w, "Could not record the owner")
	}
}

// SetLinkCap: PUT /api/cloud/links/{id}/cap {"mode": "view"|"interact"|"launch"}. Lowering it ends what the old cap allowed at once.
func (h *CloudHandler) SetLinkCap(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) || h.noLinkStore(w) {
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "mode is required")
		return
	}
	mode, ok := tunnel.ParseMode(body.Mode)
	if !ok {
		errBadRequest(w, "mode must be view, interact or launch")
		return
	}
	id := chi.URLParam(r, "id")
	old, err := h.links.SetLinkCap(r.Context(), id, mode.String())
	switch {
	case errors.Is(err, store.ErrNoCloudLink):
		errNotFound(w, "No such Hub link")
		return
	case errors.Is(err, store.ErrBadLinkState):
		errConflict(w, "This link is being removed")
		return
	case err != nil:
		errInternalServer(w, "Could not save the cap")
		return
	}
	h.linkAction(r.Context(), id, "cap", old+" -> "+mode.String())
	if mode < tunnel.TierLaunch {
		if _, err := h.ss.ClearHubAutoAccept(r.Context(), store.AutoAcceptModeLowered); err != nil {
			errInternalServer(w, "Could not turn off Coral Hub auto-accept")
			return
		}
		h.clearHubKeepFullAccess(r.Context(), "the hub's mode was lowered below Launch")
	}
	if m := h.manager(); m != nil {
		m.ModeChanged(r.Context())  // a lowered cap closes what the old one allowed
		m.LinksChanged(r.Context()) // a link added here is dialed again at its own new cap
	}
	out, err := h.linkList(r.Context())
	if err != nil {
		errInternalServer(w, "Could not read the Hub links")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": out})
}

// RemoveLink: DELETE /api/cloud/links/{id}. The link has no tunnel from the first moment; the Hub is asked to remove this computer, and the link ends here as the Hub answers.
func (h *CloudHandler) RemoveLink(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || h.noLinkStore(w) {
		return
	}
	ctx, id := r.Context(), chi.URLParam(r, "id")
	var link *store.CloudLink
	if all, err := h.links.ListLinks(ctx); err == nil {
		for i := range all {
			if all[i].LinkID == id {
				link = &all[i]
			}
		}
	}
	if link == nil {
		errNotFound(w, "No such Hub link")
		return
	}
	if err := h.links.BeginRemoveLink(ctx, id); err != nil {
		errInternalServer(w, "Could not start removing the link")
		return
	}
	if m := h.manager(); m != nil {
		m.StopLink(id)                // this link's tunnel only
		m.LinkRemoved(link.HubOrigin) // and a Hub still being added at that address
	}
	state, note, err := h.askAndSettle(ctx, *link, time.Now())
	if err != nil {
		errInternalServer(w, "Could not finish removing the link")
		return
	}
	out, _ := h.linkList(ctx)
	switch state {
	case removalWaiting:
		writeJSON(w, http.StatusAccepted, map[string]any{"links": out, "pending": true, "message": "Removing: waiting for the Hub to confirm. It is asked again every hour."})
	case removalStuck:
		writeJSON(w, http.StatusAccepted, map[string]any{"links": out, "pending": true, "stuck": true, "message": "The Hub refused the remove request. This is a Coral bug, not retried; you can drop the link here."})
	default:
		resp := map[string]any{"links": out}
		if note != "" {
			resp["message"] = note
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

type removalState int

const (
	removalDone removalState = iota
	removalWaiting
	removalStuck
)

// Removal retries: about every hour (a 429's Retry-After wins), for 7 days, then the token is deleted and the Hub is not asked again.
const (
	removalRetryEvery = time.Hour
	removalJitterMax  = 10 * time.Minute
	removalGiveUpAt   = 7 * 24 * time.Hour
)

type removalRetry struct {
	next  time.Time
	stuck bool
}

// askAndSettle asks the Hub to remove this computer, once, and ends the link here or leaves it removing, as the answer says. now is when the answer came, for the next try.
func (h *CloudHandler) askAndSettle(ctx context.Context, link store.CloudLink, now time.Time) (removalState, string, error) {
	rev := h.revoker
	if rev == nil {
		rev = newHTTPRevoker(h.hubRevokeOn, nil) // the real call, dark until its setting is on
	}
	token, terr := h.links.LinkToken(ctx, link.LinkID)
	res := RevokeResult{Answer: RevokeUnsupported}
	if terr == nil {
		res = rev.Revoke(ctx, link.HubOrigin, link.ServerID, token)
	}
	how, note := store.LinkEventRemoved, ""
	switch res.Answer {
	case RevokeRemoved, RevokeAlreadyGone, RevokeNotFound:
	case RevokeTokenRefused:
		how, note = store.LinkEventDropped, msgHubTokenRefused
	case RevokeUnsupported:
		how, note = store.LinkEventDropped, msgHubStillLists
	case RevokeBadRequest: // our own bug: asked once, never again; the person is told
		h.setRetry(link.LinkID, removalRetry{stuck: true})
		h.linkAction(ctx, link.LinkID, "remove-stuck", "the Hub refused the request")
		return removalStuck, "", nil
	default: // forbidden, busy, unreachable: still removing, asked again
		wait := removalRetryEvery + time.Duration(rand.Int63n(int64(removalJitterMax)))
		if res.RetryAfter > wait {
			wait = res.RetryAfter
		}
		h.setRetry(link.LinkID, removalRetry{next: now.Add(wait)})
		h.linkAction(ctx, link.LinkID, "remove-waiting", "the Hub has not confirmed")
		return removalWaiting, "", nil
	}
	if terr != nil { // no token to send: finish here
		how, note = store.LinkEventDropped, msgHubStillLists
	}
	if err := h.links.FinishRemoveLink(ctx, link.LinkID, how); err != nil {
		return removalDone, "", err
	}
	h.setRetry(link.LinkID, removalRetry{})
	h.linkAction(ctx, link.LinkID, how, note)
	if m := h.manager(); m != nil {
		if link.Source == store.LinkSourceEnrollment {
			_ = m.Disconnect(ctx) // forgets the enrollment the removed link mirrored
		} else {
			m.LinksChanged(ctx) // a link added here: the enrollment and every other link stay as they are
		}
	}
	return removalDone, note, nil
}

func (h *CloudHandler) setRetry(id string, r removalRetry) {
	h.retryMu.Lock()
	defer h.retryMu.Unlock()
	if h.retries == nil {
		h.retries = map[string]removalRetry{}
	}
	if r == (removalRetry{}) {
		delete(h.retries, id)
		return
	}
	h.retries[id] = r
}

// RetryRemovals asks again for every removal the Hub has not confirmed whose time has come, and at 7 days deletes the sealed token instead (the link stays so the Operator can drop it). It is safe to call at
// any time: at start and about every hour.
func (h *CloudHandler) RetryRemovals(ctx context.Context, now time.Time) {
	if h.links == nil {
		return
	}
	pending, err := h.links.RemovingLinks(ctx)
	if err != nil {
		return
	}
	all, err := h.links.ListLinks(ctx)
	if err != nil {
		return
	}
	byID := map[string]store.CloudLink{}
	for _, l := range all {
		byID[l.LinkID] = l
	}
	for _, p := range pending {
		l, ok := byID[p.LinkID]
		if !ok {
			continue
		}
		if now.Sub(p.Since) >= removalGiveUpAt {
			if err := h.links.DeleteLinkToken(ctx, p.LinkID); err == nil {
				h.linkAction(ctx, p.LinkID, "remove-gave-up", "the Hub did not confirm in 7 days; the token was deleted")
			}
			continue
		}
		h.retryMu.Lock()
		st := h.retries[p.LinkID]
		h.retryMu.Unlock()
		if st.stuck || now.Before(st.next) {
			continue
		}
		_, _, _ = h.askAndSettle(ctx, l, now)
	}
}

// StartRemovalRetry runs RetryRemovals once now and then about every hour, until ctx ends.
func (h *CloudHandler) StartRemovalRetry(ctx context.Context) {
	go func() {
		defer safego.Recover("cloud link removal retry")
		h.RetryRemovals(ctx, time.Now())
		t := time.NewTicker(removalRetryEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				h.RetryRemovals(ctx, now)
			}
		}
	}()
}
