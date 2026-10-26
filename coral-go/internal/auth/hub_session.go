// The sessions Sign in with Coral Hub makes: the KeyStore side (NewHubSession, IsHubSession), the guard that ends them when the Hub's grant is gone, EndAll, and the periodic check. Moved out of hub_signin.go (#8284), no code changed.

package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
)

// NewHubSession stores a Hub session: method hub, labelled "Coral Hub: <display>", ending at
// the sooner of the session limit and the grant's expiry; a check never extends it.
func (ks *KeyStore) NewHubSession(r *http.Request, g HubGrant) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	now := time.Now().UTC()
	life := min(sessionMaxAge, g.TTL)
	be := ks.backend()
	if err := be.PutSession(context.Background(), SessionRecord{
		IDHash: sessionHash(token), Label: "Coral Hub: " + g.Display, Method: SessionByHub,
		CreatedAt: now, LastSeen: now, ExpiresAt: now.Add(life),
		HubGrant: g.Grant, HubAccount: g.Account, HubDisplay: g.Display, HubLastOK: now,
	}); err != nil {
		return "", err
	}
	if err := be.SweepSessions(context.Background(), now, maxSessions); err != nil {
		log.Printf("[auth] couldn't sweep old sessions: %v", err)
	}
	return token, nil
}

// hubSession is the live Hub session r carries, if any.
func (ks *KeyStore) hubSession(r *http.Request) (SessionRecord, bool) {
	t := ks.extractSessionCookie(r)
	if t == "" {
		return SessionRecord{}, false
	}
	s, ok := ks.lookupSession(t)
	return s, ok && s.Method == SessionByHub
}

// IsHubSession reports whether r is signed in with a Hub session.
func (ks *KeyStore) IsHubSession(r *http.Request) bool {
	_, ok := ks.hubSession(r)
	return ok
}

// hubSessionDenied reports whether a Hub session may not make this request (design note
// section 5, Security condition 4): the password and session routes and every other
// /api/auth/ route, the login token and the API key, and everything that configures the Coral
// Hub link and its trust. Prefixes, so a route added under them is denied too.
func hubSessionDenied(method, path string) bool {
	switch {
	case strings.HasPrefix(path, "/api/auth/"):
		return true
	case strings.HasPrefix(path, "/api/cloud/"):
		return !(method == http.MethodGet && path == "/api/cloud/status")
	case path == "/api/system/login-token", path == "/api/system/api-key", strings.HasPrefix(path, "/api/system/api-key/"):
		return true
	case path == "/api/system/hub-operator", path == "/api/system/hub-mode":
		return method != http.MethodGet && method != http.MethodHead
	}
	return false
}

// HubSessionGuard runs after Middleware: a request signed in with a Hub session is refused the
// denied routes (403 hub_session_not_allowed) and its writes are recorded in the
// Operator-actions log. (SessionRequests closes its WebSockets when it ends.)
func (h *HubSignin) HubSessionGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h == nil {
			next.ServeHTTP(w, r)
			return
		}
		s, ok := h.ks.hubSession(r)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		if !h.allowedCached() {
			// Turned off here, #3404 turned on or the link gone: it ends now, not at the next check.
			h.endSession(r.Context(), s, "Sign in with Coral Hub is off on this computer")
			authError(w, http.StatusUnauthorized, "signed_out", "Signed out: Sign in with Coral Hub is off on this computer")
			return
		}
		if hubSessionDenied(r.Method, r.URL.Path) {
			authError(w, http.StatusForbidden, hubDeniedCode, "A Coral Hub sign-in can't do this: use the password on this computer")
			return
		}
		rec := &hubStatus{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if h.onAction == nil {
			return
		}
		switch {
		case r.Method != http.MethodGet && r.Method != http.MethodHead || strings.HasPrefix(r.URL.Path, "/ws/"):
			h.onAction(r.Context(), s.Label, r.Method, r.URL.Path, rec.code())
		default:
			// The read is named from the path chi routes on (an encoded slash stays inside a name), not the decoded one (#4977).
			routed := r.URL.RawPath
			if routed == "" {
				routed = r.URL.Path
			}
			if route := hubSensitiveRead(r.Method, routed); route != "" && h.readToRecord(s.IDHash, route) {
				h.onAction(r.Context(), s.Label, r.Method, route, rec.code()) // the pattern: one line per route a minute
			}
		}
	})
}

type hubStatus struct {
	http.ResponseWriter
	status int
}

func (s *hubStatus) WriteHeader(c int) {
	if s.status == 0 {
		s.status = c
	}
	s.ResponseWriter.WriteHeader(c)
}

func (s *hubStatus) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *hubStatus) code() int {
	if s.status == 0 {
		return http.StatusOK
	}
	return s.status
}

func (s *hubStatus) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// endSession ends one Hub session and closes its live requests (WebSockets).
func (h *HubSignin) endSession(ctx context.Context, s SessionRecord, why string) {
	_ = h.ks.endSession(ctx, s.IDHash)
	h.mu.Lock()
	delete(h.lastCheck, s.IDHash)
	h.mu.Unlock()
	log.Printf("[auth] a Coral Hub sign-in ended: %s", why)
	h.record(ctx, s.Label, "Coral Hub sign-in ended: "+why)
}

// EndAll ends every Hub session (the setting turned off, #3404 turned on, the link lost or
// another owner named).
func (h *HubSignin) EndAll(ctx context.Context, why string) int {
	if h == nil {
		return 0
	}
	list, err := h.ks.backend().ListSessions(ctx)
	if err != nil {
		log.Printf("[auth] couldn't list sessions to end the Coral Hub ones: %v", err)
		return 0
	}
	n := 0
	for _, s := range list {
		if s.Method == SessionByHub {
			h.endSession(ctx, s, why)
			n++
		}
	}
	return n
}

// Run checks every Hub session with Coral Hub until ctx ends: at most hubCheckEvery apart.
// An answered failure ends a session at once; unanswered checks keep it for hubCheckGrace
// after its last good check, never past its expiry. When Hub sign-in is no longer allowed
// here, every Hub session ends.
func (h *HubSignin) Run(ctx context.Context) {
	if h == nil {
		return
	}
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		h.checkOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (h *HubSignin) checkOnce(ctx context.Context) {
	list, err := h.ks.backend().ListSessions(ctx)
	if err != nil {
		return
	}
	allowed := h.allowed()
	now := h.now()
	live := map[string]bool{}
	for _, s := range list {
		if s.Method != SessionByHub || !now.Before(s.ExpiresAt) {
			continue // another method, or already expired (its next lookup deletes it)
		}
		live[s.IDHash] = true
		if !allowed {
			h.endSession(ctx, s, "Sign in with Coral Hub is off on this computer")
			continue
		}
		h.mu.Lock()
		last, seen := h.lastCheck[s.IDHash]
		if !seen {
			// First look (or after a restart): due one interval after its last good check.
			last = s.HubLastOK
		}
		due := now.Sub(last) >= hubCheckEvery
		if due {
			h.lastCheck[s.IDHash] = now
		}
		h.mu.Unlock()
		if !due {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err := h.hub.Check(cctx, s.HubGrant)
		cancel()
		switch {
		case err == nil:
			s.HubLastOK = now
			if perr := h.ks.backend().PutSession(ctx, s); perr != nil {
				log.Printf("[auth] couldn't record a Coral Hub check: %v", perr)
			}
		case errors.Is(err, ErrHubUnanswered):
			if now.Sub(s.HubLastOK) >= hubCheckGrace {
				h.endSession(ctx, s, "Coral Hub hasn't answered for 10 minutes")
			}
		default:
			h.endSession(ctx, s, "Coral Hub ended it")
		}
	}
	h.mu.Lock()
	for id := range h.lastCheck {
		if !live[id] {
			delete(h.lastCheck, id) // ended or expired
		}
	}
	h.mu.Unlock()
}

// ── Linking from the signed-out page (the unpaired path, note 1.2) ──────────
