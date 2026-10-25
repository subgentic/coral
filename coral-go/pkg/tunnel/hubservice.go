package tunnel

import (
	"context"
	"net/http"
	"unicode"
	"unicode/utf8"
)

// The Hub's service-only reads (#7364, the #7331 note section 6): a route the Coral Hub's own service reads on each machine, for a person-less purpose (which tasks of this machine came from one goal request
// that an asker sent here). It is not an owner route and not a viewer's: Coral Hub says who asked as three fields of the stream (Header.HubService, AskServer, AskBoard: the server and board the request
// was sent from), never as an HTTP header a browser could send; the connector turns them into the headers below on a service route (routes.go, service(...)) and nowhere else; the machine honours them
// only on a request this connector stamped, and refuses everyone else (an owner, a viewer, an agent, a local program) with 403.

// The local headers the connector sets from the stream's service fields.
const (
	HubServiceHeader   = "X-Coral-Hub-Service"
	HubAskServerHeader = "X-Coral-Hub-Ask-Server"
	HubAskBoardHeader  = "X-Coral-Hub-Ask-Board"
)

// maxAskerName bounds the server and board names of an asker (bytes).
const maxAskerName = 128

// HubAsker is who a service read is about: the server (empty for a board on this computer itself) and the board a goal request was sent from.
type HubAsker struct {
	Server, Board string
}

// ValidHubAsker reports whether a is a well formed asker: a board of at most maxAskerName bytes, a server of at most that (or none), both valid UTF-8 with no control, format or line character.
func ValidHubAsker(a HubAsker) bool {
	return a.Board != "" && cleanAskerName(a.Board) && (a.Server == "" || cleanAskerName(a.Server))
}

func cleanAskerName(s string) bool {
	if len(s) > maxAskerName || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029' {
			return false
		}
	}
	return true
}

type hubServiceKey struct{}

// WithHubService returns ctx carrying the asker of a service read. Session.RoundTrip sends it with the stream. A malformed asker is not kept: a half-stamp is no stamp.
func WithHubService(ctx context.Context, a HubAsker) context.Context {
	if !ValidHubAsker(a) {
		return ctx
	}
	return context.WithValue(ctx, hubServiceKey{}, a)
}

func hubServiceFrom(ctx context.Context) (HubAsker, bool) {
	a, ok := ctx.Value(hubServiceKey{}).(HubAsker)
	return a, ok
}

// IsServiceRoute reports whether (method, decodedPath) is a service route of the table (routes.go).
func IsServiceRoute(method, decodedPath string) bool {
	if method == http.MethodHead {
		method = http.MethodGet
	}
	segs, ok := splitSegments(decodedPath)
	if !ok {
		return false
	}
	for _, r := range routeTable {
		if methodMatches(r.method, method) && matchSegments(r.pattern, segs) {
			return r.service
		}
	}
	return false
}

// stampService sets the three service headers on the request headers of a stream for a service route whose stream carries a complete service stamp. Any other stream, and any other route, gets none of
// them: whatever the request itself carried under these names is removed first.
func stampService(out http.Header, h Header, method, decodedPath string) {
	out.Del(HubServiceHeader)
	out.Del(HubAskServerHeader)
	out.Del(HubAskBoardHeader)
	if !IsServiceRoute(method, decodedPath) || !h.HubService || !ValidHubAsker(HubAsker{Server: h.AskServer, Board: h.AskBoard}) {
		return
	}
	out.Set(HubServiceHeader, "1")
	out.Set(HubAskServerHeader, h.AskServer)
	out.Set(HubAskBoardHeader, h.AskBoard)
}
