package routes

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The relayed join (#20966, design #20901 v8, goal #269): a Hub's owner Allows a second Hub's request to join, and makes or revokes its request key, signed by the owner's own device (v3 kinds allow-link, make-link-key and
// revoke-link-key). The gate is tunnel.LinkRequestRelayedOpen, shut: until it is true the table refuses these routes before any handler, and the handlers ask again. The key and the Allow code leave this computer only sealed
// to the one-time X25519 key the browser put in the signed query (devicekey.SealBox): a Hub carrying the answer holds ciphertext. No seal, no value: a request with no usable key makes no key and allows nothing.

const relayedLinkBodyMax = 1 << 10

// relayedSignerMode answers the mode (view, interact, launch) the device that signed a relayed request has on this computer's own list, and whether it is one of the owner's devices; nil until wired, which refuses every relayed join request.
var relayedSignerMode func(ctx context.Context, kid string) (mode string, owner, found bool)

// SetRelayedSignerMode wires the device-list lookup.
func SetRelayedSignerMode(f func(ctx context.Context, kid string) (string, bool, bool)) {
	relayedSignerMode = f
}

// relayedLinkCall is a request the guard verified as one of the three kinds, with the body the handler will read and the browser's one-time key from the signed query.
type relayedLinkCall struct {
	m    devicekey.Relayed
	body []byte
	pk   string
	mode tunnel.Mode // the signing device's own mode
}

// relayedLink is the handler's own check that the guard verified this request as kind (the guard refuses an unsigned one first; this asks again, so removing either leaves the route refused): the gate is open, the verified
// message is of this kind, method and request URI, it names the link and the Hub person the request arrived with, the body that will be read is the body that was hashed, and the signing device is at interact or more.
// ok is false with the reason already written.
func relayedLink(w http.ResponseWriter, r *http.Request, kind devicekey.Kind) (c relayedLinkCall, ok bool) {
	if !tunnel.LinkRelayedIsOpen() || relayedSignerMode == nil {
		errForbidden(w, "that is done at this computer")
		return c, false
	}
	via, tun := cloud.ViaFrom(r.Context())
	m, signed := devicekey.RelayedFrom(r.Context())
	if !tun || via.LinkID == "" || !signed || m.Kind != kind || m.Method != r.Method || m.Path != r.URL.RequestURI() || m.Link != via.LinkID || m.HubUser != via.HubUser {
		errForbidden(w, "that needs the owner's own device to sign it")
		return c, false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, relayedLinkBodyMax+1))
	if err != nil || len(raw) > relayedLinkBodyMax || devicekey.BodySHA256(raw) != m.BodySHA256 {
		errForbidden(w, "that needs the owner's own device to sign it")
		return c, false
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	c = relayedLinkCall{m: m, body: raw}
	if kind == devicekey.AllowLink || kind == devicekey.MakeLinkKey {
		pk, qok := devicekey.BoxQuery(m.Path)
		if !qok {
			errBadRequest(w, "send the browser's one-time key (box_pk) in the signed request")
			return c, false
		}
		c.pk = pk
	}
	if refuseNonOwner(w, r) { // the table's owner rule, asked by every relayed join kind and not only the reads (Security's SHOULD on #20966)
		return c, false
	}
	mode, owner, found := relayedSignerMode(r.Context(), m.KID)
	if !found || !owner { // a Hub person's own bound device never makes or ends a key or allows a join: only the owner's
		errForbidden(w, "that needs the owner's own device to sign it")
		return c, false
	}
	pm, pok := tunnel.ParseMode(mode)
	if !pok || pm < tunnel.TierInteract {
		errForbidden(w, "that device's access setting is lower than this needs: sign with a device that has interact access")
		return c, false
	}
	c.mode = pm
	return c, true
}

// sealable checks before anything is made or allowed that the browser's key can seal: a value nobody can read must never be created.
func sealable(c relayedLinkCall) bool {
	_, err := devicekey.SealBox(c.pk, string(c.m.Kind), c.m.Nonce, "check", []byte("x"))
	return err == nil
}

// noteRelayedLink leaves the Hub's own record of what a relayed join request did: the link and the Hub person (the connector's stamp), the method and the path without its query, never a key, a code or the browser's key.
func (h *CloudHandler) noteRelayedLink(r *http.Request, detail string) {
	recordHubOwnerAction(r.Context(), h.bs, hubOwnerRequest(r), r.Method, r.URL.Path+detail, "", http.StatusOK)
}

// relayedAllow is LinkRequestAllow for a verified relayed request: at most interact (launch is given at the computer), never above the signing device's own mode, and the code goes back only sealed.
func (h *CloudHandler) relayedAllow(w http.ResponseWriter, r *http.Request) {
	c, ok := relayedLink(w, r, devicekey.AllowLink)
	if !ok {
		return
	}
	var body struct {
		Cap string `json:"cap"`
	}
	if len(c.body) > 0 && decodeJSONLimit(r, &body, relayedLinkBodyMax) != nil {
		errBadRequest(w, `send {"cap": "view" or "interact"}`)
		return
	}
	id := chi.URLParam(r, "id")
	req, err := h.links.LinkRequestByID(r.Context(), id, time.Now())
	if err != nil {
		h.linkRequestErr(w, err)
		return
	}
	if body.Cap == "" {
		body.Cap = req.CapAsked
		if pm, _ := tunnel.ParseMode(body.Cap); pm > tunnel.TierInteract {
			body.Cap = tunnel.TierInteract.String() // asked for launch: through a Hub the most is interact
		}
	}
	want, pok := tunnel.ParseMode(body.Cap)
	switch {
	case !pok:
		errBadRequest(w, `send {"cap": "view" or "interact"}`)
		return
	case want > tunnel.TierInteract:
		errForbidden(w, "launch access is given at this computer, not through a Hub")
		return
	case want > c.mode:
		errForbidden(w, "that device's access setting is lower than this level: sign with a device that has it, or give less")
		return
	}
	if !sealable(c) {
		errBadRequest(w, "that one-time key cannot be used")
		return
	}
	code, given, err := h.links.AllowLinkRequest(r.Context(), id, body.Cap, time.Now())
	if err != nil {
		h.linkRequestErr(w, err)
		return
	}
	box, err := devicekey.SealBox(c.pk, string(c.m.Kind), c.m.Nonce, id, []byte(code))
	if err != nil { // cannot happen after sealable; the request is ended so no code exists that nobody saw
		_ = h.links.DenyLinkRequest(r.Context(), id, time.Now())
		errInternalServer(w, "could not seal the code")
		return
	}
	slog.Info("cloud: link request allowed through a Hub", "request", id, "hub", req.Hub, "cap", given, "link", c.m.Link)
	h.noteRelayedLink(r, " request="+id+" cap="+given)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"box": jsonRaw(box), "cap": given, "expires_in": int(store.LinkRequestAllowedTTL.Seconds())})
}

// relayedKeyCreate is LinkKeyCreate for a verified relayed request: the key counts against the link, and goes back only sealed.
func (h *CloudHandler) relayedKeyCreate(w http.ResponseWriter, r *http.Request) {
	c, ok := relayedLink(w, r, devicekey.MakeLinkKey)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if decodeJSONLimit(r, &body, relayedLinkBodyMax) != nil {
		errBadRequest(w, `send {"name": a name for the Hub this key is for}`)
		return
	}
	if !sealable(c) {
		errBadRequest(w, "that one-time key cannot be used")
		return
	}
	id, key, err := h.links.CreateLinkKeyVia(r.Context(), body.Name, c.m.Link, time.Now())
	if err != nil {
		h.linkKeyErr(w, err)
		return
	}
	box, err := devicekey.SealBox(c.pk, string(c.m.Kind), c.m.Nonce, id, []byte(key))
	if err != nil { // cannot happen after sealable; the key is ended so no key exists that nobody saw
		_ = h.links.RevokeLinkKey(r.Context(), id, time.Now())
		errInternalServer(w, "could not seal the key")
		return
	}
	slog.Info("cloud: link key made through a Hub", "key", id, "link", c.m.Link) // never the key
	h.recordLinkKey(r, "link_key_make", id, body.Name)
	h.noteRelayedLink(r, " key="+id)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "name": cleanSavedField(body.Name), "box": jsonRaw(box)})
}

// relayedKeyRevoke is LinkKeyRevoke for a verified relayed request: only a key this same link made.
func (h *CloudHandler) relayedKeyRevoke(w http.ResponseWriter, r *http.Request) {
	c, ok := relayedLink(w, r, devicekey.RevokeLinkKey)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	name := ""
	if ks, err := h.links.ListLinkKeys(r.Context()); err == nil {
		for _, k := range ks {
			if k.ID == id {
				name = k.Name
			}
		}
	}
	if err := h.links.RevokeLinkKeyVia(r.Context(), id, c.m.Link, time.Now()); err != nil {
		h.linkKeyErr(w, err)
		return
	}
	slog.Info("cloud: link key revoked through a Hub", "key", id, "link", c.m.Link)
	h.recordLinkKey(r, "link_key_revoke", id, name)
	h.noteRelayedLink(r, " key="+id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// relayedDeny is LinkRequestDeny for a verified relayed request: a waiting request is denied (it counts toward the two-denials mute), an allowed one that is not finished is cancelled (expired, no mute), and its code stops working.
func (h *CloudHandler) relayedDeny(w http.ResponseWriter, r *http.Request) {
	c, ok := relayedLink(w, r, devicekey.DenyLink)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.links.DenyLinkRequest(r.Context(), id, time.Now()); err != nil {
		h.linkRequestErr(w, err)
		return
	}
	slog.Info("cloud: link request denied through a Hub", "request", id, "link", c.m.Link)
	h.noteRelayedLink(r, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// jsonRaw lets a sealed box, which is already JSON, sit inside a reply as it is.
type jsonRaw []byte

func (j jsonRaw) MarshalJSON() ([]byte, error) {
	if len(j) == 0 {
		return nil, errors.New("empty box")
	}
	return j, nil
}

// relayedReadOK is the check of the owner's two plain reads through a Hub (#20966): the gate is open, the request came through a link, and its Hub person is the owner the link confirmed (the table's owner rule,
// asked again). The reads need no device signature; they hold no secret. false has the reason written.
func (h *CloudHandler) relayedReadOK(w http.ResponseWriter, r *http.Request) bool {
	via, tun := cloud.ViaFrom(r.Context())
	if !tunnel.LinkRelayedIsOpen() || !tun || !tunnel.ValidLinkID(via.LinkID) {
		errForbidden(w, "that is done at this computer")
		return false
	}
	return !refuseNonOwner(w, r)
}
