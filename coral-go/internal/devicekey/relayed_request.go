package devicekey

import (
	"context"
	"strconv"
	"time"

	"github.com/subgentic/coral/internal/store"
)

// A relayed request as this computer receives it (#20879, coral-hub's signer agreed at #267139). The Hub forwards the request unchanged beside four headers: Coral-Device-Key (the signer's kid, 43 characters),
// Coral-Device-Sig (the 64-byte r||s signature, base64url, 86), Coral-Device-Ts (decimal unix seconds) and Coral-Device-Nonce (22). The computer does not read the signed text from the Hub: it builds it from its own state, so
// the signature can only be good for what this computer itself received.

// RelayedRequest is what the route's guard hands the verifier: the first four are this computer's own words (the link and the Hub person from its stamp, the method and the request URI as received), the next four the
// headers, Body the exact bytes received.
type RelayedRequest struct {
	Link, HubUser, Method, Target string
	KID, Sig, Ts, Nonce           string
	Cert                          string // the Coral-Device-Cert header (sign once, #21889); "" when the request carried none
	Body                          []byte
	// RequireTrusted is the computer's switch (#21883), set by the guard: while on, only a signer whose origin is on store.TrustedDeviceOrigins signs (signer_no_proof for any other).
	RequireTrusted bool
}

// HandleRelayedRequest finds the request's kind from KindRoutes (a route no kind lists is wrong_request), rebuilds the signed text from this computer's own state and the received bytes, and verifies it with
// HandleRelayedOn and the authorizer for the link's owner pin: the pair, the owner rules, the kind's route, the window, the signature, the body hash, and a single-use nonce spent before it returns. A request with no
// Hub person in its stamp is refused outside_pair: no actor, no message.
func (v *Verifier) HandleRelayedRequest(ctx context.Context, in RelayedRequest, pin OwnerPinFunc, now time.Time) (Relayed, error) {
	k, ok := KindOfRoute(in.Method, in.Target)
	if !ok && IsHubWrite(in.Method, in.Target) { // every other write: the one generic kind (#21883); the guard asks for it only when this computer requires a trusted device
		k, ok = HubWrite, true
	}
	if !ok {
		return Relayed{}, ErrWrongRequest
	}
	if len(in.Body) > RelayedBodyMax {
		return Relayed{}, ErrBodyTooLarge
	}
	if in.HubUser == "" {
		return Relayed{}, ErrOutsidePair
	}
	if !plainInt(in.Ts) {
		return Relayed{}, ErrBadForm
	}
	ts, err := strconv.ParseInt(in.Ts, 10, 64)
	if err != nil {
		return Relayed{}, ErrBadForm
	}
	m := Relayed{Kind: k, KID: in.KID, Computer: v.Computer, Ts: ts, Nonce: in.Nonce, Link: in.Link, HubUser: in.HubUser, Method: in.Method, Path: in.Target, BodySHA256: BodySHA256(in.Body)}
	canon, err := m.Canonical()
	if err != nil {
		return Relayed{}, err
	}
	return v.handleRelayed(ctx, in.Link, in.Method, in.Target, k, canon, in.Body, in.Sig, in.Cert, now, trustedSigner(in.RequireTrusted, GrantMemberAuthorizer(in.HubUser, pin, in.Body)))
}

type relayedKey struct{}

// WithRelayed marks a request context as one whose relayed signature this computer verified: the message that was signed. Set by the guard only; no route is given more because of it.
func WithRelayed(ctx context.Context, m Relayed) context.Context {
	return context.WithValue(ctx, relayedKey{}, m)
}

// RelayedFrom is the verified message of a request, if the guard verified one.
func RelayedFrom(ctx context.Context) (Relayed, bool) {
	m, ok := ctx.Value(relayedKey{}).(Relayed)
	return m, ok
}

// trustedSigner is authorize with, while the switch is on, the origin rule: a signer whose key was added without proof or by the bootstrap credential signs nothing (#21883).
func trustedSigner(on bool, authorize func(Relayed, store.DeviceKey) error) func(Relayed, store.DeviceKey) error {
	if !on {
		return authorize
	}
	return func(m Relayed, signer store.DeviceKey) error {
		if !store.IsTrustedDeviceOrigin(signer.Origin) {
			return ErrSignerNoProof
		}
		return authorize(m, signer)
	}
}
