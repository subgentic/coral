package routes

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
)

// RefusedRowsPerMinute caps the rows one link may add with refused writes (status >= 400) in a minute, so a loop of refused attempts cannot fill the table (Security, #20369). A write that was
// served is never capped.
// UnmatchedPairPath is the row's path for a tunneled write that matched no route.
const UnmatchedPairPath = "unmatched"

var RefusedRowsPerMinute = 30 // a variable only so a proof test that makes more than 30 refused calls can lift it for its own run

// PairRecorded names the write routes (method + chi route pattern) whose tunneled calls RecordPairWrites records. It grows batch by batch with the pair census golden; a route listed here is
// proven by a test that sends it through the real connector (internal/server pair_census_test.go).
type PairRecorded map[string]bool

// RecordPairWrites records, after the handler, one Operator-actions row for a write that came through the Coral Hub tunnel on a route in set (#20369, multi-Hub). The row holds the method, the route
// PATTERN (never the concrete path or query: they are the Hub's words), the status, and the pair, which is read only from the request context the connector stamp filled (cloud.LinkStamp), never from a
// body or a header. A local request carries no pair and records nothing. A handler that already wrote the row itself (the identity guard, a switch change) marks the request, and nothing is written twice.
// A refused write (status >= 400) is recorded too, up to RefusedRowsPerMinute per link.
func RecordPairWrites(bs *board.Store, set PairRecorded, mux chi.Routes) func(http.Handler) http.Handler {
	var mu sync.Mutex
	window := map[string][]time.Time{}
	allowRefused := func(link string, now time.Time) bool {
		mu.Lock()
		defer mu.Unlock()
		kept := window[link][:0]
		for _, t := range window[link] {
			if now.Sub(t) < time.Minute {
				kept = append(kept, t)
			}
		}
		if len(kept) >= RefusedRowsPerMinute {
			window[link] = kept
			return false
		}
		window[link] = append(kept, now)
		return true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if bs == nil || r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			via, tunneled := board.ActionViaFrom(r.Context())
			if !tunneled || via.HubUser == "" { // a pair is a link and a Hub person: a request with no person (refused for it) has no pair to record
				next.ServeHTTP(w, r)
				return
			}
			ctx, recorded := board.WithActionRecordFlag(r.Context())
			rec := &statusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r.WithContext(ctx))
			if recorded.Load() {
				return
			}
			// the pattern of the route that ran (chi sets it on the routing context the handlers shared); a guard that refused before routing leaves it empty, and then the router is matched on the path chi itself routes by: RawPath when the tunnel set it (the Hub's encoded path), else Path
			pattern := ""
			if rctx := chi.RouteContext(ctx); rctx != nil {
				pattern = rctx.RoutePattern()
			}
			if pattern == "" && mux != nil {
				path := r.URL.Path
				if r.URL.RawPath != "" {
					path = r.URL.RawPath
				}
				rc := chi.NewRouteContext()
				if mux.Match(rc, r.Method, path) {
					pattern = rc.RoutePattern()
				}
			}
			if pattern == "" {
				pattern = UnmatchedPairPath // nothing is silent: the row says a write came through and matched no route, with no path
			} else if !set[r.Method+" "+pattern] {
				return
			}
			status := rec.status
			if status == 0 {
				status = http.StatusOK
			}
			if status >= 400 && !allowRefused(via.LinkID, time.Now()) {
				return
			}
			if err := bs.RecordHubOperatorAction(context.WithoutCancel(ctx), board.HubOperatorAction{
				HubUser: via.HubUser, Kind: board.HubActionKindWrite, Method: r.Method, Path: pattern, Status: status,
			}); err != nil {
				slog.Warn("[cloud] could not record a Coral Hub write", "error", err)
			}
		})
	}
}
