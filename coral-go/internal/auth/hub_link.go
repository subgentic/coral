// Linking this computer's sign-in to a Coral Hub account: the link flow and its status. Moved out of hub_signin.go (#8284), no code changed.

package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"log"
	"net/http"

	"github.com/subgentic/coral/internal/httputil"
)

func (h *HubSignin) linkCookieName(r *http.Request) string {
	if h.ks.overHTTPS(r) {
		return "__Secure-" + hubLinkCookie
	}
	return hubLinkCookie
}

// Link links this computer to Coral Hub from the sign-in page, with the same proof of control
// as creating the password (this computer, or the setup code). enable_signin is the person's
// own tick of the separate box; nothing else turns Hub sign-in on here.
// POST /auth/hub/link {"setup_code": "...", "enable_signin": bool}
func (h *HubSignin) Link(w http.ResponseWriter, r *http.Request) {
	if refuseAgent(w, r) {
		return
	}
	if !sameOriginWrite(r, true) {
		authError(w, http.StatusForbidden, "cross_origin", "Link from Coral's own page")
		return
	}
	if r.Header.Get("X-Coral-Via-Tunnel") != "" || (h.operatorAllowed != nil && !h.operatorAllowed()) {
		authError(w, http.StatusForbidden, "not_allowed", "Linking to Coral Hub isn't allowed here")
		return
	}
	var body struct {
		SetupCode    string `json:"setup_code"`
		EnableSignin bool   `json:"enable_signin"`
	}
	if !readPasswordBody(w, r, &body) {
		return
	}
	if h.hub.Linked() {
		// Re-linking is disconnect + connect by a local Operator (Security condition 3).
		authError(w, http.StatusConflict, "already_linked", "This computer is already linked to Coral Hub")
		return
	}
	if !h.ar.fromThisComputer(r) {
		ip := clientIP(r)
		if body.SetupCode == "" {
			authError(w, http.StatusForbidden, "setup_code_required", "Enter the setup code shown on this computer")
			return
		}
		if wait := h.ar.throttle.delay(ip); wait > 0 {
			tooMany(w, wait)
			return
		}
		release, ok := h.ar.throttle.acquire(ip)
		if !ok {
			tooMany(w, slotWait)
			return
		}
		good := h.ks.checkSetupCode(body.SetupCode)
		if good {
			h.ar.throttle.success(ip)
		} else {
			h.ar.throttle.fail(ip)
		}
		release()
		if !good {
			authError(w, http.StatusForbidden, "setup_code_wrong", "That setup code is not right")
			return
		}
	}
	vurl, ucode, err := h.hub.Link(r.Context())
	if err != nil {
		log.Printf("[auth] linking to Coral Hub from the sign-in page failed: %v", err)
		authError(w, http.StatusServiceUnavailable, "link_failed", "Coral Hub couldn't be reached. Try again, or use the password.")
		return
	}
	cookie, cookieHash, err := random32()
	if err != nil {
		authError(w, http.StatusInternalServerError, "link_failed", "Couldn't start linking")
		return
	}
	h.mu.Lock()
	kept := h.links[:0]
	for _, l := range h.links {
		if h.now().Sub(l.created) < hubLinkTTL {
			kept = append(kept, l)
		}
	}
	h.links = append(kept, &hubLink{cookieHash: cookieHash, enable: body.EnableSignin, created: h.now()})
	if len(h.links) > hubFlowsMax {
		h.links = h.links[len(h.links)-hubFlowsMax:]
	}
	h.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: h.linkCookieName(r), Value: cookie, Path: hubFlowPath, MaxAge: int(hubLinkTTL.Seconds()),
		HttpOnly: true, Secure: h.ks.overHTTPS(r), SameSite: http.SameSiteStrictMode})
	h.record(r.Context(), "this computer", "linking to Coral Hub started from the sign-in page")
	httputil.WriteJSON(w, http.StatusOK, map[string]any{"verification_url": vurl, "user_code": ucode})
}

// LinkStatus reports the linking this browser started; when it is done and the person ticked
// the box, Hub sign-in is turned on here, once, and logged as "enabled while linking".
// GET /auth/hub/link/status
func (h *HubSignin) LinkStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	c, err := r.Cookie(h.linkCookieName(r))
	if err != nil || c.Value == "" {
		authError(w, http.StatusNotFound, "no_link", "No linking was started in this browser")
		return
	}
	sum := sha256.Sum256([]byte(c.Value))
	h.mu.Lock()
	var link *hubLink
	for _, l := range h.links {
		if subtle.ConstantTimeCompare(l.cookieHash[:], sum[:]) == 1 && h.now().Sub(l.created) < hubLinkTTL {
			link = l
		}
	}
	h.mu.Unlock()
	if link == nil {
		authError(w, http.StatusNotFound, "no_link", "No linking was started in this browser")
		return
	}
	state, msg := h.hub.LinkState()
	if state == "linked" {
		h.mu.Lock()
		apply := link.enable && !link.applied && !h.team()
		link.applied = true
		h.mu.Unlock()
		if apply {
			if err := h.settings.SetSigninEnabled(true); err == nil {
				log.Printf("[auth] Sign in with Coral Hub was turned on while linking from the sign-in page")
				h.record(r.Context(), "this computer", "Sign in with Coral Hub enabled while linking")
			}
		}
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]any{
		"state": state, "error": msg, "ready": state == "linked" && h.allowed() && h.hub.Ready(r.Context(), h.requestOrigin(r)),
	})
}

// ── Settings (a local, signed-in Operator; never a Hub session, an agent or the tunnel) ──
