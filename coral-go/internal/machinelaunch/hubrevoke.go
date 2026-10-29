package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Revoker ends a machine's identity at Coral Hub (#10918, coral-hub's request 3): `coral machine delete` calls it BEFORE it destroys the droplet, so the machine cannot enroll or stay enrolled after
// it is gone.
type Revoker interface {
	// Revoke revokes the identity enrolled from a credential (its id, which the Hub returned at mint), or expires the credential when it was never redeemed. Revoking what is already revoked is not an error.
	Revoke(ctx context.Context, credentialID string) error
}

// HubRevoker is the Revoker for Coral Hub, from coral-hub's own description of the route (their Lead's read of internal/bootstrapapi/destroy.go, relayed on the board at 09:50 and 09:54 on 2026-10-29; THE
// ROUTE IS DARK IN PRODUCTION until their operator enables it, and the details below are ASSUMED until they confirm them to us):
//
//	POST /api/bootstrap/credentials/{credential_id}/revoke
//	Authorization: Bearer chd_...   (exactly one header; no cookie; no body; NO Origin header: any Origin is a 403)
//	200 {"ok":true}  revoked, or already revoked or consumed and ended (idempotent)
//	401              a bad, missing or duplicate Authorization header, or an automation key that was revoked
//	404 not_found    an unknown, another key's, another account's, non-UUID or superseded credential id (one answer for all)
//	429 Retry-After  two limits: 60 a minute per client address (IPv6 per /64) and 30 a minute per chd_ key prefix
//	503 machine_revocation_unavailable  the Hub has no revocation backend configured (a wiring state); a plain 503 is transient
//
// The destroy credential (chd_) is a secret like the provider token: it comes from a 0600 file, lives in memory, goes only to the Hub, never follows a redirect and is never in an error, a log or the state file.
type HubRevoker struct {
	BaseURL    string       // the Hub's origin (https; plain http only for a loopback address, for tests)
	DestroyKey string       // the chd_ destroy credential
	HTTP       *http.Client // nil: a client with a 30 second timeout that follows no redirect
	// Sleep waits between tries; nil is time.Sleep honouring the context. A test gives its own.
	Sleep func(ctx context.Context, d time.Duration) error
	// MaxTries is how many times a 429, a 503 or a transport failure is tried (0 is 5).
	MaxTries int
}

var (
	destroyKeyShape = regexp.MustCompile(`^chd_[A-Za-z0-9_\-]{8,200}$`)
	credentialID    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{7,63}$`)
)

// RevokeKind tells what went wrong, for the one sentence a person is told.
type RevokeKind int

const (
	RevokeTransport     RevokeKind = iota // could not reach Coral Hub
	RevokeUnauthorized                    // the destroy credential was not accepted
	RevokeNotFound                        // the Hub does not know this credential for this key
	RevokeRateLimited                     // 429 after the tries
	RevokeUnavailable                     // a transient 503 after the tries
	RevokeNotConfigured                   // 503 machine_revocation_unavailable: the Hub has no revocation backend yet
	RevokeRefused                         // any other answer
)

// RevokeError is a failed revoke, said in this tool's words (never the key, never the body).
type RevokeError struct {
	Kind   RevokeKind
	Status int
}

func (e *RevokeError) Error() string {
	switch e.Kind {
	case RevokeUnauthorized:
		return "Coral Hub did not accept the destroy credential (it may be wrong, or its automation key was revoked): the machine's Hub identity was NOT revoked"
	case RevokeNotFound:
		return "Coral Hub does not know this machine's credential for that destroy credential (unknown, another key's, or already replaced): the machine's Hub identity was not revoked by this call"
	case RevokeRateLimited:
		return "Coral Hub is rate limiting revokes just now: the machine's Hub identity was NOT revoked; try again in a minute"
	case RevokeUnavailable:
		return "Coral Hub could not revoke just now (it answered 503): the machine's Hub identity was NOT revoked; try again in a few minutes"
	case RevokeNotConfigured:
		return "Coral Hub has no machine revocation configured yet (it answered machine_revocation_unavailable): the machine's Hub identity was NOT revoked; remove the machine in Coral Hub"
	case RevokeTransport:
		return "could not reach Coral Hub: the machine's Hub identity was NOT revoked"
	}
	return fmt.Sprintf("Coral Hub refused the revoke (HTTP %d): the machine's Hub identity was NOT revoked", e.Status)
}

func (r *HubRevoker) sleep(ctx context.Context, d time.Duration) error {
	if r.Sleep != nil {
		return r.Sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Revoke makes the request. A 429 waits what Retry-After says (at most two minutes) and tries again; a 503 and a transport failure wait a little longer each time; the rest are answered at once.
func (r *HubRevoker) Revoke(ctx context.Context, id string) error {
	if !destroyKeyShape.MatchString(r.DestroyKey) {
		return errors.New("the Coral Hub destroy credential does not look like one (it starts with chd_): check the --hub-destroy-file")
	}
	if !credentialID.MatchString(id) {
		return errors.New("the machine's credential id is not one this tool understands")
	}
	base, err := (&HubClient{BaseURL: r.BaseURL}).endpoint()
	if err != nil {
		return err
	}
	endpoint := base + "/" + id + "/revoke"
	tries := r.MaxTries
	if tries <= 0 {
		tries = 5
	}
	client := r.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse } // the destroy credential goes to this host and no other
	var last *RevokeError
	for attempt := 1; attempt <= tries; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
		if err != nil {
			return errors.New("could not make the request to Coral Hub")
		}
		req.Header.Set("Authorization", "Bearer "+r.DestroyKey) // the only header the Hub looks at: no Origin, no cookie, no body
		req.Header.Set("User-Agent", "coral-machine-delete")
		resp, err := c.Do(req)
		var wait time.Duration
		switch {
		case err != nil:
			if ctx.Err() != nil {
				return ctx.Err()
			}
			last, wait = &RevokeError{Kind: RevokeTransport}, time.Duration(attempt)*2*time.Second // the error text of a transport failure may hold the URL: dropped
		default:
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxHubAnswer))
			resp.Body.Close()
			switch resp.StatusCode {
			case http.StatusOK:
				return nil
			case http.StatusUnauthorized:
				return &RevokeError{Kind: RevokeUnauthorized, Status: resp.StatusCode}
			case http.StatusNotFound:
				return &RevokeError{Kind: RevokeNotFound, Status: resp.StatusCode}
			case http.StatusTooManyRequests:
				last, wait = &RevokeError{Kind: RevokeRateLimited, Status: resp.StatusCode}, retryAfter429(resp.Header.Get("Retry-After"))
			case http.StatusServiceUnavailable:
				kind := RevokeUnavailable
				if strings.Contains(string(raw), "machine_revocation_unavailable") {
					kind = RevokeNotConfigured
				}
				last, wait = &RevokeError{Kind: kind, Status: resp.StatusCode}, time.Duration(attempt)*2*time.Second
			default:
				return &RevokeError{Kind: RevokeRefused, Status: resp.StatusCode}
			}
		}
		if attempt == tries {
			break
		}
		if err := r.sleep(ctx, wait); err != nil {
			return err
		}
	}
	return last
}

// retryAfter429 reads a Retry-After in seconds, between 1 second and 2 minutes (a missing or odd value is 30 seconds: the limits are per minute).
func retryAfter429(v string) time.Duration {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 1 {
		return 30 * time.Second
	}
	if n > 120 {
		n = 120
	}
	return time.Duration(n) * time.Second
}
