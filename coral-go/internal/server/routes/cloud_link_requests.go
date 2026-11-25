package routes

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/store"
)

// A second Hub asks to join this Coral (#20936, design #20901 v4). Every route here is the person at this computer's: never tunneled (the tunnel table has none of them), never an agent's, never a Hub's. A request is a
// pending row: it links nothing and grants nothing. Allow shows the code once, in its own response; finish checks it and runs the same enroll `coral cloud links add` runs.
//
//	POST /api/cloud/link-requests              {hub, cap}  -> {request_id, poll_secret, expires_at}   (the secret is shown once)
//	GET  /api/cloud/link-requests                           -> {requests: [...]} the waiting ones (the Needs-you card); no secret, no code
//	GET  /api/cloud/link-requests/{id}         X-Link-Request-Secret -> {state}  pending|allowed|denied|expired|done
//	POST /api/cloud/link-requests/{id}/allow   {cap?}      -> {code, cap}   the person at this computer only; the code is in no other read
//	POST /api/cloud/link-requests/{id}/deny    {}          -> {ok}
//	POST /api/cloud/link-requests/{id}/finish  {poll_secret, code} -> {enrollment}   takes no address: only the origin that was allowed
//	                                           {poll_secret, code, link: "key"} -> {linked, cap}   a request key's own Hub, as a key link (#21220)

const linkRequestSecretHeader = "X-Link-Request-Secret"

// linkRequestCaller is who may make, poll and finish a request: the person at this computer (the dashboard or the signed command line). Or a self-hosted Hub's own request key, for these three calls.
func (h *CloudHandler) linkRequestCaller(w http.ResponseWriter, r *http.Request) (cred string, refused bool) {
	if id := linkKeyCaller(r); id != "" { // a self-hosted Hub's request key, admitted by the identity layer for these three calls only
		return id, h.noLinkStore(w)
	}
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || h.noLinkStore(w) {
		return "", true
	}
	return "", false
}

// linkRequestHuman is the person at this computer: Allow, Deny and the feed. Not an agent, not a key.
func (h *CloudHandler) linkRequestHuman(w http.ResponseWriter, r *http.Request) bool {
	if linkKeyCaller(r) != "" {
		errForbidden(w, "Only the person at this computer can answer a request to join")
		return true
	}
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || h.noLinkStore(w) {
		return true
	}
	if !humanInputCaller(r) {
		errForbidden(w, "Only the person at this computer can answer a request to join")
		return true
	}
	return false
}

func (h *CloudHandler) linkRequestErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrLinkRequestNone):
		errNotFound(w, "No such request")
	case errors.Is(err, store.ErrLinkRequestState):
		writeError(w, http.StatusConflict, "link_request_state", "That request is not waiting for that")
	case errors.Is(err, store.ErrLinkRequestCode):
		writeError(w, http.StatusForbidden, "wrong_code", "That is not the code")
	case errors.Is(err, store.ErrLinkRequestCap):
		errBadRequest(w, "A Hub cannot be given more than it asked for")
	case errors.Is(err, store.ErrLinkExists):
		writeError(w, http.StatusConflict, "already_linked", store.ErrLinkExists.Error())
	case errors.Is(err, store.ErrTooManyLinks):
		writeError(w, http.StatusConflict, "too_many_links", "This computer is linked to the most Hubs it can be.")
	case errors.Is(err, store.ErrSecondLinkNotYet):
		writeError(w, http.StatusConflict, "second_link_not_yet", "This Coral links to one Hub for now. Remove that link first.")
	case errors.Is(err, store.ErrLinkRequestBusy):
		httputil.WriteActionLimit(w, 0, "link_request_busy", "Too many requests are waiting. Answer or wait for them first.")
	case errors.Is(err, store.ErrLinkRequestRate):
		httputil.WriteActionLimit(w, 0, "rate_limited", "Too many requests in the last hour. Try again later.")
	case errors.Is(err, store.ErrLinkRequestMuted):
		httputil.WriteActionLimit(w, 0, "link_request_muted", "That Hub's requests were denied twice. It may ask again in an hour.")
	default:
		errBadRequest(w, cleanSavedField(err.Error())) // an address or cap that is not valid: our own words
	}
}

// LinkRequestCreate: POST /api/cloud/link-requests.
func (h *CloudHandler) LinkRequestCreate(w http.ResponseWriter, r *http.Request) {
	cred, refused := h.linkRequestCaller(w, r)
	if refused || !requireJSON(w, r) {
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
	now := time.Now()
	id, secret, err := h.links.CreateLinkRequest(r.Context(), body.Hub, body.Cap, cred, now)
	if err != nil {
		h.linkRequestErr(w, err)
		return
	}
	slog.Info("cloud: link request made", "request", id, "cred", cred)
	writeJSON(w, http.StatusOK, map[string]any{"request_id": id, "poll_secret": secret, "state": "pending", "expires_at": now.Add(store.LinkRequestPendingTTL).UTC().Format(time.RFC3339)})
}

type linkRequestView struct {
	ID        string `json:"id"`
	Hub       string `json:"hub"`
	CapAsked  string `json:"cap_asked"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
	// Links is how many this computer has now, and Max the most it can have ("1 of 8").
	Links int `json:"links"`
	Max   int `json:"max"`
	// Via is the name of the request key that asked ("via key <name>"), when a key did.
	Via string `json:"via,omitempty"`
}

// LinkRequestFeed: GET /api/cloud/link-requests. The waiting requests, for the card: the Hub's address (Hub B's one supplied word) and the access it asked. No secret, no code.
func (h *CloudHandler) LinkRequestFeed(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) { // the owner's read through a Hub, behind a gate that ships shut (#20966); the same words, no more
		if !h.relayedReadOK(w, r) {
			return
		}
	} else if h.linkRequestHuman(w, r) {
		return
	}
	ps, err := h.links.PendingLinkRequests(r.Context(), time.Now())
	if err != nil {
		errInternalServer(w, "Could not read the requests")
		return
	}
	links, _ := h.links.ListLinks(r.Context())
	out := make([]linkRequestView, 0, len(ps))
	for _, p := range ps {
		out = append(out, linkRequestView{ID: p.ID, Hub: cleanSavedField(p.Hub), CapAsked: p.CapAsked, CreatedAt: p.CreatedAt.UTC().Format(time.RFC3339), ExpiresAt: p.ExpiresAt.UTC().Format(time.RFC3339), Links: len(links), Max: store.MaxCloudLinks, Via: cleanSavedField(p.Via)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": out})
}

// LinkRequestStatus: GET /api/cloud/link-requests/{id}, the poll secret in X-Link-Request-Secret (never the URL, which is logged).
func (h *CloudHandler) LinkRequestStatus(w http.ResponseWriter, r *http.Request) {
	if _, refused := h.linkRequestCaller(w, r); refused {
		return
	}
	st, err := h.links.LinkRequestStatus(r.Context(), chi.URLParam(r, "id"), r.Header.Get(linkRequestSecretHeader), time.Now())
	if err != nil {
		h.linkRequestErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"state": st})
}

// LinkRequestAllow: POST /api/cloud/link-requests/{id}/allow {cap?}. The person here allows, optionally a lower cap; the 8-digit code is in this response and nowhere else.
func (h *CloudHandler) LinkRequestAllow(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) { // only the owner's own signed device, behind a gate that ships shut (#20966); anything else through a Hub is refused below as before
		if _, signed := devicekey.RelayedFrom(r.Context()); signed {
			h.relayedAllow(w, r)
			return
		}
	}
	if h.linkRequestHuman(w, r) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Cap string `json:"cap"`
	}
	_ = decodeJSONLimit(r, &body, 1024)
	id := chi.URLParam(r, "id")
	req, err := h.links.LinkRequestByID(r.Context(), id, time.Now())
	if err != nil {
		h.linkRequestErr(w, err)
		return
	}
	if body.Cap == "" {
		body.Cap = req.CapAsked
	}
	code, given, err := h.links.AllowLinkRequest(r.Context(), id, body.Cap, time.Now())
	if err != nil {
		h.linkRequestErr(w, err)
		return
	}
	slog.Info("cloud: link request allowed", "request", id, "hub", req.Hub, "cap", given)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"code": code, "cap": given, "expires_in": int(store.LinkRequestAllowedTTL.Seconds())})
}

// LinkRequestDeny: POST /api/cloud/link-requests/{id}/deny.
func (h *CloudHandler) LinkRequestDeny(w http.ResponseWriter, r *http.Request) {
	if _, signed := devicekey.RelayedFrom(r.Context()); signed && cloud.Tunneled(r) {
		h.relayedDeny(w, r)
		return
	}
	if h.linkRequestHuman(w, r) || !requireJSON(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.links.DenyLinkRequest(r.Context(), id, time.Now()); err != nil {
		h.linkRequestErr(w, err)
		return
	}
	slog.Info("cloud: link request denied", "request", id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// LinkRequestFinish: POST /api/cloud/link-requests/{id}/finish {poll_secret, code}. It takes no address. One transaction checks the secret, the clock, the tries and the code and marks the request used; then the existing
// enroll (the one `coral cloud links add` runs) goes to the origin that was allowed, with the cap given.
func (h *CloudHandler) LinkRequestFinish(w http.ResponseWriter, r *http.Request) {
	key, refused := h.linkRequestCaller(w, r)
	if refused || !requireJSON(w, r) {
		return
	}
	var body struct {
		PollSecret string `json:"poll_secret"`
		Code       string `json:"code"`
		// Link "key" is a self-hosted Hub that reaches computers over HTTP and asks for a key link (#21220, design B); "" is the enroll, as before.
		Link string `json:"link"`
	}
	if err := decodeJSONLimit(r, &body, 1024); err != nil || (body.Link != "" && body.Link != "key") {
		errBadRequest(w, "send {\"poll_secret\": ..., \"code\": ..., \"link\": \"key\" for a key link}")
		return
	}
	m := h.manager()
	if m == nil {
		errInternalServer(w, "The Coral Hub connector is not available") // before the request is used up
		return
	}
	id := chi.URLParam(r, "id")
	if finishFailuresOver(time.Now()) {
		httputil.WriteActionLimit(w, int(finishFailureWindow.Seconds()), "rate_limited", "Too many wrong codes just now. Try again in a few minutes.")
		return
	}
	if body.Link == "key" && key == "" {
		errBadRequest(w, "Only a Hub's own request key can finish as a key link")
		return
	}
	if body.Link == "key" { // a self-hosted Hub's own request key (#21220, design B): the request becomes the link that key answers to, at the cap the person gave; no enroll, no tunnel to the Hub, no secret sent
		l, err := h.links.FinishLinkRequestAsKeyLink(r.Context(), id, body.PollSecret, body.Code, key, time.Now())
		if err != nil {
			if errors.Is(err, store.ErrLinkRequestCode) {
				noteFinishFailure(time.Now())
			}
			h.linkRequestErr(w, err)
			return
		}
		m.LinksChanged(r.Context())
		slog.Info("cloud: link request finished as a key link", "request", id, "link", l.LinkID, "hub", l.HubOrigin, "cap", l.MaxMode)
		writeJSON(w, http.StatusOK, map[string]any{"linked": true, "cap": l.MaxMode})
		return
	}
	hub, linkCap, err := h.links.FinishLinkRequestBy(r.Context(), id, body.PollSecret, body.Code, key, time.Now())
	if err != nil {
		if errors.Is(err, store.ErrLinkRequestCode) {
			noteFinishFailure(time.Now())
		}
		h.linkRequestErr(w, err)
		return
	}
	pe, err := m.AddLinkByOrigin(r.Context(), hub, linkCap)
	slog.Info("cloud: link request finished", "request", id, "hub", hub, "ok", err == nil)
	var rl *cloud.RateLimitedError
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]any{"enrollment": viewOfEnrollment(*pe)})
	case errors.As(err, &rl):
		httputil.WriteActionLimit(w, 0, "rate_limited", "That Hub is busy. Ask again in a moment.")
	case errors.Is(err, cloud.ErrHubUnavailable), errors.Is(err, cloud.ErrHubResponse):
		writeError(w, http.StatusBadGateway, "hub_unreachable", "Coral could not get a code from that Hub. Ask again.")
	default:
		h.linkRequestErr(w, err)
	}
}

// ServeKeyLink carries a request of a linked request key (#21220) through its link's in-process tunnel, at the link's cap. It reports false, writing nothing, when the key answers to no active link.
func (h *CloudHandler) ServeKeyLink(w http.ResponseWriter, r *http.Request, keyID string) bool {
	if h.links == nil {
		return false
	}
	l, err := h.links.KeyLink(r.Context(), keyID)
	if err != nil {
		return false
	}
	m := h.manager()
	if m == nil {
		writeError(w, http.StatusServiceUnavailable, "key_link_not_open", "This computer's link for that Hub is not open yet. Try again in a moment.")
		return true
	}
	if err := m.ServeKeyLink(w, r, l.LinkID); err != nil {
		writeError(w, http.StatusServiceUnavailable, "key_link_not_open", "This computer's link for that Hub is not open yet. Try again in a moment.")
	}
	return true
}
