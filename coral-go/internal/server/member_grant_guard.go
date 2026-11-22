package server

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Codes of a request the owner's grant refuses (#20473, S2).
const (
	memberGrantEndedCode = "member_grant_ended"
	memberGrantLowCode   = "member_grant_too_low"
)

// memberGrantTier is the most a grant gives, as a tunnel tier. A view grant reads; a full grant is the link's cap and no more, so it is as high as the cap lets it be (the lower of the two is
// taken by the caller, on every request).
func memberGrantTier(level string) tunnel.Mode {
	switch level {
	case board.MemberLevelFull:
		return tunnel.TierLaunch
	case board.MemberLevelView:
		return tunnel.TierView
	}
	return tunnel.TierNever // an unknown level gives nothing
}

// memberGrantAllows decides one request of a Hub person who has been given a grant: the person's best live grant, lowered by the link's cap now, must reach the tier the route needs. A person who
// never had a grant on the link is not decided here (the owner and the Hub's own roles are as before until the owner pin lands), but one whose grants were all ended, expired or whose link is no
// longer active gets nothing: ending a grant must close access, not hand the person back an unbounded one. Nothing is cached: the table and the link are read again on every request.
func memberGrantAllows(ctx context.Context, bs *board.Store, linkCap func(context.Context, string) (tunnel.Mode, bool), v cloud.Via, need tunnel.Tier, now time.Time) (ok bool, code string) {
	if bs == nil || v.HubUser == "" {
		return true, ""
	}
	live, ever, err := bs.MemberGrantsOfPerson(ctx, v.LinkID, v.HubUser, now)
	if err != nil {
		slog.Warn("[cloud] could not read a Hub person's access; the request is refused", "link", v.LinkID, "error", err)
		return false, memberGrantEndedCode
	}
	if !ever {
		return true, ""
	}
	if len(live) == 0 {
		return false, memberGrantEndedCode
	}
	capMode, active := linkCap(ctx, v.LinkID)
	if !active {
		return false, memberGrantEndedCode // the link is removed or revoked: a grant never outlives it
	}
	best := tunnel.TierNever
	for _, g := range live {
		if t := memberGrantTier(g.Level); t > best {
			best = t
		}
	}
	if tunnel.Lower(best, capMode) < need {
		return false, memberGrantLowCode
	}
	return true, ""
}

// MemberGrantGuard is the S2 check on every tunneled request: after the link stamp (so the pair is the connector's own) and before any route. A local request has no pair and is not touched. Cloud.Guard
// has already refused a route that is not in the table, so a route that classifies as never here is left to it.
func MemberGrantGuard(bs *board.Store, linkCap func(context.Context, string) (tunnel.Mode, bool)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			v, tunneled := cloud.ViaFrom(r.Context())
			if !tunneled {
				next.ServeHTTP(w, r)
				return
			}
			need := tunnel.Classify(r.Method, r.URL.Path, r.URL.RawQuery)
			if need == tunnel.TierNever {
				next.ServeHTTP(w, r)
				return
			}
			if ok, code := memberGrantAllows(r.Context(), bs, linkCap, v, need, time.Now()); !ok {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				msg := "the access you were given has ended"
				if code == memberGrantLowCode {
					msg = "the access you were given does not include this"
				}
				_, _ = w.Write([]byte(`{"error":"` + msg + `","code":"` + code + `"}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
