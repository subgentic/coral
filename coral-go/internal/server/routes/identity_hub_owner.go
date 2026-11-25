package routes

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/subgentic/coral/pkg/hubowner"
)

// The signed owner stamp, remote side (#11378, gap A). A hub that reaches this Coral with its API key may add X-Coral-Hub-Owner to ONE of a few requests (hubowner.Routes: Approve / Request changes, Ignore and Undo of a question (#13462), and the
// change-request send) when the person behind them is signed in at the hub. This file decides whether the stamp is genuine; if it is, the request is a person's (humanInputCaller) and nothing else about
// the caller changes. The secret it checks against was written by a human act (hubowner.WriteFile); no route here can write it.

// ProcessStart is when this process started (the routes package's initialisation, which runs first): a stamp made before it is refused, so one captured before a restart is dead after it.
var ProcessStart = time.Now()

// callerHubOwner is an API-key request that carries a verified owner stamp: the hub's signed-in person.
const callerHubOwner = "hub_owner"

// hubOwnerStamps holds what the remote needs to verify stamps: the data folder the secrets are in and the time this process started. Each hub link's verifier (with its replay table) is kept while its
// secret stays the same; a rotated secret makes a new one (#21213: one secret per hub, so two hubs on one Coral both work).
type hubOwnerStamps struct {
	dir   string
	start time.Time
	mu    sync.Mutex
	lv    *hubowner.LinkVerifiers
	noted time.Time // the secrets' time as last noted in the log (zero: none was there)
}

// note logs every time a hub's secret is installed, replaced or removed: a person's act at this computer, which must not pass silently (a rotation is exactly what an owner would want to see). It is
// called from startup, from the health answer and from each stamp check, so a change shows within moments of anyone looking. It returns the newest secret's time.
func (h *hubOwnerStamps) note() (time.Time, bool) {
	at, ok := hubowner.InstalledAt(h.dir)
	h.mu.Lock()
	defer h.mu.Unlock()
	switch {
	case ok && !at.Equal(h.noted):
		slog.Warn("[hub owner stamp] a hub's secret was installed, replaced or removed: the hubs' owner stamps for this computer are now checked against the secrets held", "at", at.Format(time.RFC3339))
		h.noted = at
	case !ok && !h.noted.IsZero():
		slog.Warn("[hub owner stamp] no hub's secret is held or usable: the hubs' owner stamps are refused")
		h.noted = time.Time{}
	}
	return at, ok
}

// check verifies one stamp against the hub links held here. It returns the link that made it, or the reason it was refused and the link it was checked against (nil when none or several).
func (h *hubOwnerStamps) check(hub, value, method, decodedPath, target string, body []byte) (*hubowner.Link, string, *hubowner.Link) {
	h.note()
	links, err := hubowner.Links(h.dir)
	if err != nil {
		slog.Warn("[hub owner stamp] the hubs' secrets could not be read", "error", err.Error())
		links = nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.lv == nil {
		h.lv = &hubowner.LinkVerifiers{Start: h.start}
	}
	return h.lv.Check(links, hub, value, method, decodedPath, target, body)
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

// checkOwnerStamp looks at a request's stamp header. No header: nothing to say (stamped false, ok true). A header is refused, never ignored (403 hub_owner_stamp_refused, with a reason code and a sentence
// that names the hub and what to fix), unless it is on a request that carries the API key, is the only one, is for an allowlisted route, has a body within the cap and verifies against the secret of the hub
// that signed it. The body is read here and put back.
func (o *IdentityObserver) checkOwnerStamp(w http.ResponseWriter, r *http.Request, caller string) (stamped, ok bool) {
	vals := stampValues(r)
	if len(vals) == 0 {
		return false, true
	}
	hubs := r.Header.Values(hubowner.LinkHeader)
	refuse := func(reason, why string, link *hubowner.Link) (bool, bool) {
		attrs := []any{"reason", reason, "why", why, "route", r.Method + " " + r.URL.Path}
		if link != nil {
			attrs = append(attrs, "link", link.Hub, "remote", link.Remote)
		} else if len(hubs) == 1 && hubowner.ValidHubID(hubs[0]) {
			attrs = append(attrs, "link", hubs[0])
		}
		slog.Info("[hub owner stamp] refused", attrs...)
		o.refuseDetail(w, http.StatusForbidden, "hub_owner_stamp_refused", reason, stampRefusal(reason, link))
		return false, false
	}
	if caller != callerAPIKey || len(vals) != 1 || o.stamps == nil {
		return refuse(hubowner.ReasonMalformed, "not an API-key request, more than one stamp, or stamps are off", nil)
	}
	hub := ""
	if len(hubs) > 1 || len(hubs) == 1 && !hubowner.ValidHubID(hubs[0]) {
		return refuse(hubowner.ReasonMalformed, "more than one hub link, or not a hub id", nil)
	} else if len(hubs) == 1 {
		hub = hubs[0]
	}
	var body []byte
	if r.Body != nil {
		b, err := io.ReadAll(io.LimitReader(r.Body, hubowner.MaxBody+1))
		if err != nil || len(b) > hubowner.MaxBody {
			return refuse(hubowner.ReasonMalformed, "the body is unreadable or too large", nil)
		}
		body = b
		r.Body = io.NopCloser(bytes.NewReader(b))
		r.ContentLength = int64(len(b))
	}
	if _, reason, link := o.stamps.check(hub, vals[0], r.Method, r.URL.Path, hubowner.Target(r.URL), body); reason != "" {
		return refuse(reason, "the stamp did not verify", link)
	}
	return true, true
}

// stampRefusal is the sentence a person sees for a refused stamp: what went wrong, the hub when this Coral can tell which one, and what to fix. Only a stale stamp is about the clocks.
func stampRefusal(reason string, link *hubowner.Link) string {
	hub := "the hub"
	if link != nil {
		hub = "the hub " + strconv.Quote(link.Label())
	}
	switch reason {
	case hubowner.ReasonStale:
		return "The owner stamp from " + hub + " is too old or too new for this computer, so it was refused. Check that this computer's clock and the hub's clock are right, then try again."
	case hubowner.ReasonWrongSecret:
		return "The owner stamp from " + hub + " does not match the secret this computer holds for it, so it was refused. In that hub, open this computer and set up Approve through the hub again."
	case hubowner.ReasonReplay:
		return "This owner stamp from " + hub + " was already used, so it was refused. Try again."
	case hubowner.ReasonNoSecret:
		return "This computer holds no hub's owner stamp secret, so the stamp was refused. In the hub, open this computer and set up Approve through the hub."
	case hubowner.ReasonUnknownLink:
		return "This computer holds no owner stamp secret from the hub you used (only other hubs'), so the stamp was refused. In that hub, open this computer and set up Approve through the hub."
	}
	return "The hub's owner stamp on this request is not valid, so it was refused."
}
