package hubproxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/subgentic/coral/pkg/hubowner"
)

// The owner stamp (#11378, gap A): when the person signed in at THIS hub makes one of the two decisions that need a person (hubowner.Routes), the hub signs the forwarded request, and the remote
// knows it is a person's and not a script's holding the hub's API key. The hub's own identity layer decides who the person is; this package only signs.

type signedInOwnerKey struct{}

// WithSignedInOwner marks a request as made by the person signed in at this hub: its dashboard session, with the CSRF and Origin checks the hub already made, never an API key or an agent token.
// Only the hub's own routing sets it (routes.MountRemoteProxy); a browser cannot send it.
func WithSignedInOwner(ctx context.Context) context.Context {
	return context.WithValue(ctx, signedInOwnerKey{}, true)
}

func signedInOwner(ctx context.Context) bool { v, _ := ctx.Value(signedInOwnerKey{}).(bool); return v }

type sessionSignedInKey struct{}

// WithSessionSignedIn marks that the signed-in person of this request holds a real SIGN-IN SESSION at this hub (the identity layer's dashboard cookie), not only this computer's own same-origin browser with sign-in
// off (#13725, Security's condition on #13694: with sign-in off any local program counts as the hub's owner, so the widened routes are not signed for it). Only the hub's own routing sets it.
func WithSessionSignedIn(ctx context.Context) context.Context {
	return context.WithValue(ctx, sessionSignedInKey{}, true)
}

func sessionSignedIn(ctx context.Context) bool { v, _ := ctx.Value(sessionSignedInKey{}).(bool); return v }

// remoteGenerations remembers, per remote, which generation of the owner-stamp allowlist its health answer says it accepts (hub_owner_routes), for generationTTL: a hub asks a remote only when a widened route is about
// to be signed, at most once a minute. A remote that does not say (an older Coral) accepts generation 1, the original eight; a remote that cannot be asked is taken at the last answer or at 1.
type remoteGenerations struct {
	mu sync.Mutex
	m  map[string]generationEntry
}

type generationEntry struct {
	gen int
	at  time.Time
}

const generationTTL = time.Minute

// remoteGeneration is the allowlist generation remote id accepts, read from its /api/health when the kept answer is older than generationTTL.
func (h *Handler) remoteGeneration(ctx context.Context, id string, t Target) int {
	h.gens.mu.Lock()
	e, ok := h.gens.m[id]
	h.gens.mu.Unlock()
	if ok && time.Since(e.at) < generationTTL {
		return e.gen
	}
	gen := 1
	if ok {
		gen = e.gen // asked before: an unreachable remote keeps its last answer
	}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if resp, err := Get(rctx, t, "/api/health", ""); err == nil {
		var body struct {
			Routes int `json:"hub_owner_routes"`
		}
		if resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body) == nil {
			gen = max(body.Routes, 1)
		}
		resp.Body.Close()
	}
	h.gens.mu.Lock()
	if h.gens.m == nil {
		h.gens.m = map[string]generationEntry{}
	}
	h.gens.m[id] = generationEntry{gen: gen, at: time.Now()}
	h.gens.mu.Unlock()
	return gen
}

// stampGeneration is the allowlist generation this request may be signed at: the original eight for any signed-in owner; the widened routes (#13694) only when the person holds a sign-in session at this hub and only up
// to what the remote itself says it accepts, so an older remote gets a widened click unstamped, as before, never refused.
func (h *Handler) stampGeneration(ctx context.Context, id string, t Target, method, dec string) int {
	if !sessionSignedIn(ctx) || !hubowner.AllowedAt(method, dec, hubowner.RoutesVersion) || hubowner.AllowedAt(method, dec, stampedGeneration) {
		return stampedGeneration
	}
	return min(h.remoteGeneration(ctx, id, t), hubowner.RoutesVersion)
}

// OwnerStamper is a Target that can sign an owner stamp for a request it is about to send: target is the escaped path and query as the remote will see them. ok is false when the target holds no secret.
type OwnerStamper interface {
	OwnerStamp(method, target string, body []byte) (stamp string, ok bool)
}

// OwnerStamp implements OwnerStamper for a remote reached by URL.
func (t HTTPTarget) OwnerStamp(method, target string, body []byte) (string, bool) {
	if t.OwnerSecret == "" || t.RemoteID == "" {
		return "", false
	}
	s, err := hubowner.Sign(t.OwnerSecret, t.RemoteID, method, target, body, time.Now())
	return s, err == nil
}
