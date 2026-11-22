package cloud

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Via is who a tunneled action is for (#20312, multi-Hub design v2 2.5, 2.6): the link it arrived on and the Hub person behind it. The link is the connector's own (it names the cloud_link whose
// token opened the tunnel); the person is the stream's label and is attribution only: no tier, owner, grant or Allow answer reads it as authority. The type is the board's, where the records
// that carry it are written.
type Via = board.ActionVia

// ViaFrom returns the pair a request carries. ok is false for a local request (no tunnel): a writer then records an empty pair, and a tunneled request that has none was already refused.
func ViaFrom(ctx context.Context) (Via, bool) { return board.ActionViaFrom(ctx) }

// WithVia returns ctx carrying v (for the middleware and for tests of a writer).
func WithVia(ctx context.Context, v Via) context.Context { return board.WithActionVia(ctx, v) }

// AllowFunc is the one check point for a tunneled action (design v2 2.3): the link and person, what is being done (the method) and to what (the path). It returns whether to go on and, when
// not, a short reason. Today it allows every action; limits later go behind it with no route change.
type AllowFunc func(ctx context.Context, v Via, action, resource string) (bool, string)

// LinkEnded is called when a link stops being usable for good: the person removed it, or the Hub revoked its token. The server wires it to end every grant that came through the link
// (RevokeMemberGrantsOfLink, #20473), so a grant never outlives the link it names. It does nothing until wired.
var LinkEnded = func(ctx context.Context, linkID string) {}

// AllowAll is the first build's Allow.
func AllowAll(context.Context, Via, string, string) (bool, string) { return true, "" }

// LinkRefusedCode is the closed code of the 403 for a request with no known link or one Allow refuses.
const LinkRefusedCode = "hub_link_refused"

func refuseLink(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(`{"error":"this request did not come through a known Coral Hub link","code":"` + LinkRefusedCode + `"}`))
}

// allow runs fn and denies on a panic or a nil fn: it never fails open.
func allow(fn AllowFunc, ctx context.Context, v Via, action, resource string) (ok bool) {
	if fn == nil {
		return false
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("cloud: the Allow check panicked; the request is refused", "panic", r)
			ok = false
		}
	}()
	ok, _ = fn(ctx, v, action, resource)
	return ok
}

// LinkStamp is the server side of the link stamp. For a request the connector really made (TunneledAuthentic): the link id it stamped must be well formed and known (known), or the request is
// refused with 403 (a connection with no link, and a stale id, are never served); the Hub person's label is read only from the connector's own header; the pair goes in the context; and Allow
// runs once, denying on an error or panic. For every other request the two headers are removed (a local program or a forged stamp can send them, and no one may be believed through them) and
// the request goes on unchanged, with no pair: it is a local action.
func LinkStamp(known func(ctx context.Context, linkID string) bool, fn AllowFunc) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, actor := r.Header.Get(tunnel.LinkHeader), r.Header.Get(tunnel.ActorHeader)
			if !TunneledAuthentic(r) {
				r.Header.Del(tunnel.LinkHeader)
				r.Header.Del(tunnel.ActorHeader)
				next.ServeHTTP(w, r)
				return
			}
			// More than one value is a stamp the connector never makes.
			if len(r.Header.Values(tunnel.LinkHeader)) != 1 || len(r.Header.Values(tunnel.ActorHeader)) > 1 ||
				!tunnel.ValidLinkID(id) || known == nil || !known(r.Context(), id) {
				refuseLink(w)
				return
			}
			if !tunnel.ValidHubUser(actor) {
				actor = ""
			}
			v := Via{LinkID: id, HubUser: actor}
			if !allow(fn, r.Context(), v, r.Method, r.URL.EscapedPath()) {
				refuseLink(w)
				return
			}
			next.ServeHTTP(w, r.WithContext(WithVia(r.Context(), v)))
		})
	}
}

// AskAnswerer is what AskAllow reads: whether a link may answer a kind of ask (store.CloudStore).
type AskAnswerer interface {
	LinkAskAllowed(ctx context.Context, linkID, kind string) (bool, error)
}

// AskAllow is the Allow of the link stamp (#20413): a request that answers an ask (the closed table of tunnel.AskRouteKind) is let through only when the link may answer that kind, read from the store on this
// call. Every other request passes unchanged and keeps its own checks. A store error or a missing store refuses (allow turns a nil or panicking check into a refusal as well).
func AskAllow(a AskAnswerer) AllowFunc {
	return func(ctx context.Context, v Via, method, path string) (bool, string) {
		kind := tunnel.AskRouteKind(method, path)
		if kind == "" {
			return true, ""
		}
		if a == nil {
			return false, "no ask list"
		}
		ok, err := a.LinkAskAllowed(ctx, v.LinkID, kind)
		if err != nil || !ok {
			return false, "this Hub may not answer that kind of question through this link"
		}
		return true, ""
	}
}
