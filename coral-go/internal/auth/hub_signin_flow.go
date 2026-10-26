// The sign-in with Coral Hub flow: Start (the one-time state and the redirect) and Callback (the code exchange and the session), with the flow cookie and its state table. Moved out of hub_signin.go (#8284), no code changed.

package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/httputil"
)

// takeStart applies the start limits (per address and global, a minute each) and makes room
// for a flow: the oldest open flow is dropped only when it is at least a minute old.
func (h *HubSignin) takeStart(addr string) bool {
	addr = rateKey(addr)
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	recent := func(ts []time.Time) []time.Time {
		out := ts[:0]
		for _, t := range ts {
			if now.Sub(t) < time.Minute {
				out = append(out, t)
			}
		}
		return out
	}
	h.startsAll = recent(h.startsAll)
	h.starts[addr] = recent(h.starts[addr])
	for a, ts := range h.starts {
		if len(ts) == 0 {
			delete(h.starts, a)
		}
	}
	if len(h.startsAll) >= hubStartsGlobal || len(h.starts[addr]) >= hubStartsPerAddr {
		return false
	}
	h.dropExpiredLocked(now)
	// One client cannot hold every place: with hubFlowsPerAddr flows open, its next start replaces its own oldest, young or not (#4977: five starts
	// a minute from one address kept every other person's sign-in refused).
	mine := 0
	for _, f := range h.flows {
		if f.addr == addr {
			mine++
		}
	}
	for i := 0; mine >= hubFlowsPerAddr && i < len(h.flows); {
		if h.flows[i].addr == addr {
			h.flows = append(h.flows[:i], h.flows[i+1:]...)
			mine--
			continue
		}
		i++
	}
	if len(h.flows) >= hubFlowsMax {
		if now.Sub(h.flows[0].created) < hubFlowYoungest {
			return false
		}
		h.flows = h.flows[1:]
	}
	h.startsAll = append(h.startsAll, now)
	h.starts[addr] = append(h.starts[addr], now)
	return true
}

func (h *HubSignin) dropExpiredLocked(now time.Time) {
	kept := h.flows[:0]
	for _, f := range h.flows {
		if now.Sub(f.created) < hubFlowTTL && !f.used {
			kept = append(kept, f)
		}
	}
	h.flows = kept
}

func (h *HubSignin) flowCookieName(r *http.Request) string {
	if h.ks.overHTTPS(r) {
		return "__Secure-" + hubFlowCookie
	}
	return hubFlowCookie
}

func (h *HubSignin) setFlowCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: h.flowCookieName(r), Value: value, Path: hubFlowPath, MaxAge: maxAge,
		HttpOnly: true, Secure: h.ks.overHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
}

// Start begins a Hub sign-in from the sign-in page's form and sends the browser to Coral Hub.
// POST /auth/hub/start
func (h *HubSignin) Start(w http.ResponseWriter, r *http.Request) {
	if refuseAgent(w, r) {
		return
	}
	if !sameOriginWrite(r, true) {
		authError(w, http.StatusForbidden, "cross_origin", "Start the sign-in from Coral's own page")
		return
	}
	origin := h.requestOrigin(r)
	if !h.allowed() || origin == "" || !h.hub.Ready(r.Context(), origin) {
		hubBack(w, r, "unavailable")
		return
	}
	if !h.takeStart(clientIP(r)) {
		// A per-action limit (X-Coral-Limit: action), so a dashboard never takes it for an overloaded server.
		httputil.WriteActionLimitBody(w, 60, map[string]any{"error": "Too many sign-ins started. Try again in a minute.", "code": "too_many_attempts"})
		return
	}
	verifier, _, err1 := random32()
	state, stateHash, err2 := random32()
	cookie, cookieHash, err3 := random32()
	if err1 != nil || err2 != nil || err3 != nil {
		hubBack(w, r, "unavailable")
		return
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	page, err := h.hub.Start(r.Context(), challenge, state, origin)
	if err != nil {
		if errors.Is(err, ErrHubDisabled) {
			h.mu.Lock()
			h.disabledSeen = h.now()
			h.mu.Unlock()
			hubBack(w, r, "disabled")
			return
		}
		log.Printf("[auth] Coral Hub couldn't start a sign-in: %v", err)
		hubBack(w, r, "unavailable")
		return
	}
	h.mu.Lock()
	h.flows = append(h.flows, &hubFlow{stateHash: stateHash, cookieHash: cookieHash, verifier: verifier, origin: origin, addr: rateKey(clientIP(r)), created: h.now()})
	h.mu.Unlock()
	h.setFlowCookie(w, r, cookie, int(hubFlowTTL.Seconds()))
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, page, http.StatusSeeOther)
}

// takeFlow finds the flow state names, checks the flow cookie and the origin, and marks it
// used. Every failure burns the flow it found. Compares are constant time.
func (h *HubSignin) takeFlow(r *http.Request, state, cookie string) (*hubFlow, bool) {
	stateHash := sha256.Sum256([]byte(state))
	cookieHash := sha256.Sum256([]byte(cookie))
	origin := h.requestOrigin(r)
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	var found *hubFlow
	for _, f := range h.flows {
		if subtle.ConstantTimeCompare(f.stateHash[:], stateHash[:]) == 1 {
			found = f
		}
	}
	if found == nil {
		return nil, false
	}
	ok := !found.used && now.Sub(found.created) < hubFlowTTL && cookie != "" &&
		subtle.ConstantTimeCompare(found.cookieHash[:], cookieHash[:]) == 1 &&
		subtle.ConstantTimeCompare([]byte(found.origin), []byte(origin)) == 1
	found.used = true // single use, whatever happens next
	h.dropExpiredLocked(now)
	return found, ok
}

// Callback is where Coral Hub sends the browser back: it redeems the code at once over the
// tunnel and signs this browser in.
// GET /auth/hub/callback?code=...&state=...
func (h *HubSignin) Callback(w http.ResponseWriter, r *http.Request) {
	hdr := w.Header()
	hdr.Set("Referrer-Policy", "no-referrer")
	hdr.Set("Cache-Control", "no-store")
	hdr.Set("X-Frame-Options", "DENY")
	var cookie string
	if c, err := r.Cookie(h.flowCookieName(r)); err == nil {
		cookie = c.Value
	}
	h.setFlowCookie(w, r, "", -1) // cleared on success and on failure
	fail := func(why string) {
		log.Printf("[auth] a Coral Hub sign-in was refused (%s) from %s", why, clientIP(r))
		h.ar.audit.add(clientIP(r), "Coral Hub", false)
		hubBack(w, r, "failed")
	}
	q := r.URL.Query()
	code, state := q.Get("code"), q.Get("state")
	if r.Header.Get(agentTokenHeader) != "" || !h.allowed() {
		fail("not allowed now")
		return
	}
	f, ok := h.takeFlow(r, state, cookie)
	if !ok {
		fail("flow")
		return
	}
	g, err := h.hub.Redeem(r.Context(), code, f.verifier)
	if err != nil {
		fail("redeem")
		return
	}
	if old := h.ks.extractSessionCookie(r); old != "" {
		h.ks.RevokeSession(old)
	}
	token, err := h.ks.NewHubSession(r, g)
	if err != nil {
		fail("session")
		return
	}
	label := "Coral Hub: " + g.Display
	h.ar.audit.add(clientIP(r), label, true)
	log.Printf("[auth] signed in with Coral Hub from %s", clientIP(r))
	h.record(r.Context(), label, "signed in with Coral Hub")
	h.ks.setSessionCookie(w, r, token, false)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}
