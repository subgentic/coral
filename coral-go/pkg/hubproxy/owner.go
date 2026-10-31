package hubproxy

import (
	"context"
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
