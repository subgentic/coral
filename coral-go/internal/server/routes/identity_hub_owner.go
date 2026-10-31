package routes

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/subgentic/coral/pkg/hubowner"
)

// The signed owner stamp, remote side (#11378, gap A). A hub that reaches this Coral with its API key may add X-Coral-Hub-Owner to ONE of two requests (hubowner.Routes: Approve / Request changes, and the
// change-request send) when the person behind them is signed in at the hub. This file decides whether the stamp is genuine; if it is, the request is a person's (humanInputCaller) and nothing else about
// the caller changes. The secret it checks against was written by a human act (hubowner.WriteFile); no route here can write it.

// ProcessStart is when this process started (the routes package's initialisation, which runs first): a stamp made before it is refused, so one captured before a restart is dead after it.
var ProcessStart = time.Now()

// callerHubOwner is an API-key request that carries a verified owner stamp: the hub's signed-in person.
const callerHubOwner = "hub_owner"

// hubOwnerStamps holds what the remote needs to verify stamps: the data folder the secret file is in and the time this process started. The verifier (with its replay table) is kept while the file stays
// the same; a rotated secret makes a new one.
type hubOwnerStamps struct {
	dir   string
	start time.Time
	mu    sync.Mutex
	key   string
	v     *hubowner.Verifier
	noted time.Time // the secret file's time as last noted in the log (zero: none was there)
}

// note logs every time the secret file is installed, replaced or removed: a person's act at this computer, which must not pass silently (a rotation is exactly what an owner would want to see). It is
// called from startup, from the health answer and from each stamp check, so a change shows within moments of anyone looking. It returns the file's time.
func (h *hubOwnerStamps) note() (time.Time, bool) {
	at, ok := hubowner.InstalledAt(h.dir)
	h.mu.Lock()
	defer h.mu.Unlock()
	switch {
	case ok && !at.Equal(h.noted):
		slog.Warn("[hub owner stamp] the secret file was installed or replaced: the hub's owner stamps for this computer are now checked against it", "at", at.Format(time.RFC3339))
		h.noted = at
	case !ok && !h.noted.IsZero():
		slog.Warn("[hub owner stamp] the secret file is gone or not usable: the hub's owner stamps are refused")
		h.noted = time.Time{}
	}
	return at, ok
}

func (h *hubOwnerStamps) verifier() *hubowner.Verifier {
	h.note()
	id, secret, ok, err := hubowner.ReadFile(h.dir)
	if err != nil || !ok {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if key := id + "\x00" + secret; h.v == nil || h.key != key {
		h.v, h.key = &hubowner.Verifier{Secret: secret, RemoteID: id, Start: h.start}, key
	}
	return h.v
}

// SetHubOwnerDir turns stamp checking on, against the secret file in dir. start is when this process started.
func (o *IdentityObserver) SetHubOwnerDir(dir string, start time.Time) {
	o.stamps = &hubOwnerStamps{dir: dir, start: start}
	o.stamps.note() // a secret already there at startup is logged once
}

// HubOwnerStampAt is when the secret file was last written, for the health answer; ok is false when none is installed. Asking also logs a change since the last look.
func (o *IdentityObserver) HubOwnerStampAt() (time.Time, bool) {
	if o == nil || o.stamps == nil {
		return time.Time{}, false
	}
	return o.stamps.note()
}

// stampValues is every value of the header, in any spelling of its name.
func stampValues(r *http.Request) []string {
	var out []string
	for k, v := range r.Header {
		if http.CanonicalHeaderKey(k) == hubowner.Header {
			out = append(out, v...)
		}
	}
	return out
}

// checkOwnerStamp looks at a request's stamp header. No header: nothing to say (stamped false, ok true). A header is refused, never ignored (403 hub_owner_stamp_refused, one fixed sentence whatever was
// wrong), unless it is on a request that carries the API key, is the only one, is for an allowlisted route, has a body within the cap and verifies. The body is read here and put back.
func (o *IdentityObserver) checkOwnerStamp(w http.ResponseWriter, r *http.Request, caller string) (stamped, ok bool) {
	vals := stampValues(r)
	if len(vals) == 0 {
		return false, true
	}
	refuse := func(why string) (bool, bool) {
		slog.Info("[hub owner stamp] refused", "reason", why, "route", r.Method+" "+r.URL.Path)
		o.refuse(w, http.StatusForbidden, "hub_owner_stamp_refused", "The hub's owner stamp on this request is not valid, so it was refused. Check that both computers' clocks are right.")
		return false, false
	}
	if caller != callerAPIKey || len(vals) != 1 || o.stamps == nil {
		return refuse("not an API-key request, more than one stamp, or stamps are off")
	}
	v := o.stamps.verifier()
	if v == nil {
		return refuse("no secret installed")
	}
	var body []byte
	if r.Body != nil {
		b, err := io.ReadAll(io.LimitReader(r.Body, hubowner.MaxBody+1))
		if err != nil || len(b) > hubowner.MaxBody {
			return refuse("the body is unreadable or too large")
		}
		body = b
		r.Body = io.NopCloser(bytes.NewReader(b))
		r.ContentLength = int64(len(b))
	}
	if err := v.Verify(vals[0], r.Method, r.URL.Path, hubowner.Target(r.URL), body); err != nil {
		return refuse(err.Error())
	}
	return true, true
}
