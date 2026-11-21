package routes

import (
	"bufio"
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
)

// RefusedRowsPerMinute caps the rows one link may add with refused writes (status >= 400) in a minute, so a loop of refused attempts cannot fill the table (Security, #20369). A write that was
// served is never capped.
// UnmatchedPairPath is the row's path for a tunneled write that matched no route.
const UnmatchedPairPath = "unmatched"

// StreamOpensPerMinute bounds the served WebSocket opens one link may make in a minute; past it the open is refused with 429, never left without a row (#20405).
var StreamOpensPerMinute = 600

var RefusedRowsPerMinute = 30 // a variable only so a proof test that makes more than 30 refused calls can lift it for its own run

// PairRecorded names the write routes (method + chi route pattern) whose tunneled calls RecordPairWrites records. It grows batch by batch with the pair census golden; a route listed here is
// proven by a test that sends it through the real connector (internal/server pair_census_test.go).
type PairRecorded map[string]bool

// RecordPairWrites records, after the handler, one Operator-actions row for a write that came through the Coral Hub tunnel on a route in set (#20369, multi-Hub). The row holds the method, the route
// PATTERN (never the concrete path or query: they are the Hub's words), the status, and the pair, which is read only from the request context the connector stamp filled (cloud.LinkStamp), never from a
// body or a header. A local request carries no pair and records nothing. A handler that already wrote the row itself (the identity guard, a switch change) marks the request, and nothing is written twice.
// A refused write (status >= 400) is recorded too, up to RefusedRowsPerMinute per link.
func RecordPairWrites(bs *board.Store, set PairRecorded, upgrades PairRecorded, mux chi.Routes) func(http.Handler) http.Handler {
	var mu sync.Mutex
	window := map[string][]time.Time{}
	count := func(win map[string][]time.Time, limit int, link string, now time.Time) bool {
		mu.Lock()
		defer mu.Unlock()
		kept := win[link][:0]
		for _, t := range win[link] {
			if now.Sub(t) < time.Minute {
				kept = append(kept, t)
			}
		}
		if len(kept) >= limit {
			win[link] = kept
			return false
		}
		win[link] = append(kept, now)
		return true
	}
	allowRefused := func(link string, now time.Time) bool { return count(window, RefusedRowsPerMinute, link, now) }
	// served streams have their own bound, apart from the refused-row cap: a refused flood can never hide a stream, and a flood of served opens is refused (never silent) once past it
	opens := map[string][]time.Time{}
	allowOpen := func(link string, now time.Time) bool { return count(opens, StreamOpensPerMinute, link, now) }
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if bs == nil || r.Method == http.MethodHead || r.Method == http.MethodOptions || (r.Method == http.MethodGet && !isUpgrade(r)) {
				next.ServeHTTP(w, r)
				return
			}
			via, tunneled := board.ActionViaFrom(r.Context())
			if !tunneled || via.HubUser == "" { // a pair is a link and a Hub person: a request with no person (refused for it) has no pair to record
				next.ServeHTTP(w, r)
				return
			}
			if r.Method == http.MethodGet { // a WebSocket upgrade: a row at connect and one at close, with the pair and no body
				serveUpgrade(bs, upgrades, mux, via, allowRefused, allowOpen, w, r, next)
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

// Methods of the two rows a WebSocket upgrade leaves (#20405): terminal input and agent control travel on it after the handshake, so the computer says who opened it and when it ended.
const (
	PairWSOpen  = "WS-OPEN"
	PairWSClose = "WS-CLOSE"
)

func isUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// serveUpgrade records an upgrade on a route in upgrades: a row before the handler runs (the stream may last hours) and a row after it returns, with the status a refusal answered, else 101.
// The route is found by the router itself, on the path chi routes by; the pair is the one the connector stamped (a stream with no Hub person never gets here: wrapper's caller skips it).
func serveUpgrade(bs *board.Store, upgrades PairRecorded, mux chi.Routes, via board.ActionVia, allowRefused, allowOpen func(string, time.Time) bool, w http.ResponseWriter, r *http.Request, next http.Handler) {
	path := r.URL.Path
	if r.URL.RawPath != "" {
		path = r.URL.RawPath
	}
	pattern := ""
	if mux != nil {
		rc := chi.NewRouteContext()
		if mux.Match(rc, http.MethodGet, path) {
			pattern = rc.RoutePattern()
		}
	}
	if pattern == "" {
		pattern = UnmatchedPairPath
	} else if !upgrades["GET "+pattern] {
		next.ServeHTTP(w, r)
		return
	}
	record := func(method string, status int) error {
		err := bs.RecordHubOperatorAction(context.WithoutCancel(r.Context()), board.HubOperatorAction{
			HubUser: via.HubUser, Kind: board.HubActionKindWrite, Method: method, Path: pattern, Status: status,
		})
		if err != nil {
			slog.Warn("[cloud] could not record a Coral Hub stream", "error", err)
		}
		return err
	}
	// the open row comes first and is never capped as a refusal: a stream that cannot leave its row is not opened (503), and one past the open bound is refused (429)
	if !allowOpen(via.LinkID, time.Now()) {
		http.Error(w, "too many streams opened through this link in a minute", http.StatusTooManyRequests)
		return
	}
	if record(PairWSOpen, 0) != nil {
		http.Error(w, "the stream could not be recorded", http.StatusServiceUnavailable)
		return
	}
	rec := &upgradeRecorder{ResponseWriter: w}
	next.ServeHTTP(rec, r)
	status := rec.status
	if status == 0 {
		status = http.StatusSwitchingProtocols
	}
	// only a refused upgrade counts against the refused-row cap; the close of a served stream is always written, so no open is left without its end
	if status >= 400 && !allowRefused(via.LinkID, time.Now()) {
		return
	}
	_ = record(PairWSClose, status)
}

// upgradeRecorder remembers the status of an answer written before the upgrade (a refusal); it passes the connection takeover through, which a WebSocket upgrade needs.
type upgradeRecorder struct {
	http.ResponseWriter
	status int
}

func (u *upgradeRecorder) WriteHeader(code int) {
	if u.status == 0 {
		u.status = code
	}
	u.ResponseWriter.WriteHeader(code)
}

func (u *upgradeRecorder) Write(b []byte) (int, error) {
	if u.status == 0 {
		u.status = http.StatusOK
	}
	return u.ResponseWriter.Write(b)
}

func (u *upgradeRecorder) Unwrap() http.ResponseWriter { return u.ResponseWriter }

func (u *upgradeRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(u.ResponseWriter).Hijack()
}

func (u *upgradeRecorder) Flush() { _ = http.NewResponseController(u.ResponseWriter).Flush() }
