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
}

func (h *hubOwnerStamps) verifier() *hubowner.Verifier {
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
		o.refuse(w, http.StatusForbidden, "hub_owner_stamp_refused", "The hub's owner stamp on this request is not valid, so it was refused")
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
