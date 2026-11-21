package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

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
	writeJSON(w, http.StatusOK, map[string]any{"links": out, "max_links": store.MaxCloudLinks})
}

func (h *CloudHandler) noLinkStore(w http.ResponseWriter) bool {
	if h.links == nil {
		errInternalServer(w, "Hub links are not available")
		return true
	}
	return false
}

// AddLink: POST /api/cloud/links. A second link is refused while the store's switch is off (Security 1); the first link is made by Connect.
func (h *CloudHandler) AddLink(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) || h.noLinkStore(w) {
		return
	}
	switch err := h.links.CheckCanAddLink(r.Context()); {
	case errors.Is(err, store.ErrSecondLinkNotYet):
		writeError(w, http.StatusConflict, "second_link_not_yet", "This Coral links to one Hub for now. Remove that link first.")
	case errors.Is(err, store.ErrTooManyLinks):
		writeError(w, http.StatusConflict, "too_many_links", "This computer is linked to the most Hubs it can be.")
	case err != nil:
		errInternalServer(w, "Could not check the Hub links")
	default:
		errBadRequest(w, "To link the first Hub, use Connect")
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
		m.ModeChanged(r.Context()) // a lowered cap closes what the old one allowed
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
		m.StopTunnel()
	}
	rev := h.revoker
	if rev == nil {
		rev = newHTTPRevoker(h.hubRevokeOn, nil) // the real call, dark until its setting is on
	}
	token, terr := h.links.LinkToken(ctx, id)
	answer := RevokeUnsupported
	if terr == nil {
		answer = rev.Revoke(ctx, link.HubOrigin, link.ServerID, token).Answer
	}
	how, note := store.LinkEventRemoved, ""
	switch answer {
	case RevokeRemoved, RevokeAlreadyGone, RevokeNotFound:
	case RevokeTokenRefused:
		how, note = store.LinkEventDropped, msgHubTokenRefused
	case RevokeUnsupported:
		how, note = store.LinkEventDropped, msgHubStillLists
	case RevokeBadRequest: // our own bug: not retried; the person is told
		h.linkAction(ctx, id, "remove-stuck", "the Hub refused the request")
		out, _ := h.linkList(ctx)
		writeJSON(w, http.StatusAccepted, map[string]any{"links": out, "pending": true, "stuck": true, "message": "The Hub refused the remove request. This is a Coral bug, not retried; you can drop the link here."})
		return
	default: // forbidden, retry: the link stays removing and is asked again
		h.linkAction(ctx, id, "remove-waiting", "the Hub has not confirmed")
		out, _ := h.linkList(ctx)
		writeJSON(w, http.StatusAccepted, map[string]any{"links": out, "pending": true, "message": "Removing: waiting for the Hub to confirm. It is asked again every hour."})
		return
	}
	if terr != nil { // no token to send: finish here
		how, note = store.LinkEventDropped, msgHubStillLists
	}
	if err := h.links.FinishRemoveLink(ctx, id, how); err != nil {
		errInternalServer(w, "Could not finish removing the link")
		return
	}
	h.linkAction(ctx, id, how, note)
	if m := h.manager(); m != nil {
		_ = m.Disconnect(ctx) // forgets the enrollment the removed link mirrored
	}
	out, _ := h.linkList(ctx)
	resp := map[string]any{"links": out}
	if note != "" {
		resp["message"] = note
	}
	writeJSON(w, http.StatusOK, resp)
}
