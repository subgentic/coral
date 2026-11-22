package server

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Codes of a request the owner's grant refuses (#20473, S2).
const (
	memberGrantEndedCode = "member_grant_ended"
	memberGrantLowCode   = "member_grant_too_low"
	memberGrantScopeCode = "member_grant_out_of_scope"
)

// grantRoute is the request a grant is checked against for its scope: nil to check the tier alone.
type grantRoute struct {
	method, path string
	viewOnly     bool               // set by memberGrantAllows: the person holds View grants and no Full one
	used         *board.MemberGrant // set by memberGrantAllows: the best live grant, the one that let the request through
}

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
func memberGrantAllows(ctx context.Context, bs *board.Store, linkCap func(context.Context, string) (tunnel.Mode, bool), v cloud.Via, need tunnel.Tier, now time.Time, route *grantRoute) (ok bool, code string) {
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
	full := false
	for _, g := range live {
		if t := memberGrantTier(g.Level); t > best {
			best = t
		}
		if g.Level == board.MemberLevelFull {
			full = true
		}
	}
	if tunnel.Lower(best, capMode) < need {
		return false, memberGrantLowCode
	}
	// A person with only View grants reaches the closed View list, and only for a board they were given (V1, V4): the tier says what a route may do, the scope says whose it is. A Full grant is the whole computer.
	if route != nil {
		for i := range live {
			if route.used == nil || memberGrantTier(live[i].Level) > memberGrantTier(route.used.Level) {
				route.used = &live[i]
			}
		}
	}
	if !full && route != nil {
		route.viewOnly = true
		if !viewScopeAllows(live, route) {
			return false, memberGrantScopeCode
		}
	}
	return true, ""
}

// viewScopeAllows is true when the request is on the View list and its board is the board of one of the person's live board grants. An agent-scope grant gives nothing here (that scope stays off, V5), and an empty or unknown
// scope gives nothing, never everything (B5).
func viewScopeAllows(live []board.MemberGrant, route *grantRoute) bool {
	b, ok := tunnel.ViewGrantBoard(route.method, route.path)
	if !ok {
		return false
	}
	for _, g := range live {
		if g.Level == board.MemberLevelView && g.ScopeKind == board.MemberScopeBoard && g.ScopeID != "" && g.ScopeID == b {
			return true
		}
	}
	return false
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
			route := &grantRoute{method: r.Method, path: r.URL.Path}
			if ok, code := memberGrantAllows(r.Context(), bs, linkCap, v, need, time.Now(), route); !ok {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				msg := "the access you were given has ended"
				if code == memberGrantLowCode || code == memberGrantScopeCode {
					msg = "the access you were given does not include this"
				}
				_, _ = w.Write([]byte(`{"error":"` + msg + `","code":"` + code + `"}`))
				return
			}
			noteGrantUse(r.Context(), bs, route.used)
			if route.viewOnly { // a View person is answered by a typed shape of allowlisted fields (V2)
				r = r.WithContext(cloud.WithViewOnly(r.Context()))
			}
			next.ServeHTTP(w, r)
		})
	}
}

// memberGrantSweepEvery is how often the open streams of Hub people are checked against the grant table: a revoked or expired grant closes its streams within this long.
const memberGrantSweepEvery = 2 * time.Second

// SweepOpenStreams asks, for every open stream of a Hub person, the same question a new request is asked (the grant table and the link's cap, read now), and ends the streams that no longer pass. It returns how many it
// ended. A person who never had a grant is not decided here, as for a request.
func SweepOpenStreams(ctx context.Context, bs *board.Store, linkCap func(context.Context, string) (tunnel.Mode, bool), now time.Time) int {
	ended := 0
	for _, k := range tunnel.OpenStreamKeys() {
		if k.Need == tunnel.TierNever {
			continue
		}
		if ok, _ := memberGrantAllows(ctx, bs, linkCap, cloud.Via{LinkID: k.Link, HubUser: k.User}, k.Need, now, &grantRoute{method: k.Method, path: k.Path}); !ok {
			n := tunnel.EndOpenStreams(k)
			ended += n
			slog.Info("[cloud] open streams of a Hub person were closed: their access ended", "link", k.Link, "streams", n)
		}
	}
	return ended
}

// RunMemberGrantSweeper sweeps every interval until ctx ends.
func RunMemberGrantSweeper(ctx context.Context, bs *board.Store, linkCap func(context.Context, string) (tunnel.Mode, bool), every time.Duration) {
	if bs == nil {
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			SweepOpenStreams(ctx, bs, linkCap, time.Now())
		}
	}
}

// firstUseSeen holds the grants whose first use this process has already noted, so the table is written once per grant and a request pays nothing more.
var firstUseSeen sync.Map

// noteGrantUse records the first use of a grant that let a request through (F5): the owner sees it in Needs you. A failure to record is logged and never refuses the request.
func noteGrantUse(ctx context.Context, bs *board.Store, g *board.MemberGrant) {
	if bs == nil || g == nil {
		return
	}
	if _, seen := firstUseSeen.LoadOrStore(g.GrantID, true); seen {
		return
	}
	if _, err := bs.NoteMemberGrantFirstUse(context.WithoutCancel(ctx), *g); err != nil {
		firstUseSeen.Delete(g.GrantID) // try again on the next request
		slog.Warn("[cloud] could not record the first use of a Hub person's access", "link", g.LinkID, "error", err)
	}
}
