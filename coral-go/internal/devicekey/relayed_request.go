package devicekey

import (
	"context"
	"strconv"
	"time"
)

// A relayed request as this computer receives it (#20879, coral-hub's signer agreed at #267139). The Hub forwards the request unchanged beside four headers: Coral-Device-Key (the signer's kid, 43 characters),
// Coral-Device-Sig (the 64-byte r||s signature, base64url, 86), Coral-Device-Ts (decimal unix seconds) and Coral-Device-Nonce (22). The computer does not read the signed text from the Hub: it builds it from its own state, so
// the signature can only be good for what this computer itself received.

// RelayedRequest is what the route's guard hands the verifier: the first four are this computer's own words (the link and the Hub person from its stamp, the method and the request URI as received), the next four the
// headers, Body the exact bytes received.
type RelayedRequest struct {
	Link, HubUser, Method, Target string
	KID, Sig, Ts, Nonce           string
	Body                          []byte
}

// HandleRelayedRequest finds the request's kind from KindRoutes (a route no kind lists is wrong_request), rebuilds the signed text from this computer's own state and the received bytes, and verifies it with
// HandleRelayedOn and the authorizer for the link's owner pin: the pair, the owner rules, the kind's route, the window, the signature, the body hash, and a single-use nonce spent before it returns. A request with no
// Hub person in its stamp is refused outside_pair: no actor, no message.
func (v *Verifier) HandleRelayedRequest(ctx context.Context, in RelayedRequest, pin OwnerPinFunc, now time.Time) (Relayed, error) {
	k, ok := KindOfRoute(in.Method, in.Target)
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
	return v.HandleRelayedOn(ctx, in.Link, in.Method, in.Target, k, canon, in.Body, in.Sig, now, GrantMemberAuthorizer(in.HubUser, pin, in.Body))
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
