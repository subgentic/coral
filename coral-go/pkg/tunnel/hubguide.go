package tunnel

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// The guide role (#11457, the Coral half of coral-hub's #11446): a second person with a grant on ONE board. Coral Hub marks such a viewer as fields of the stream (Header.HubRole "guide", GuideBoard,
// GuideLabel), never as HTTP headers a browser could send. The connector turns them into the headers below on a route of the closed table of this file (guideRoutes) and nowhere else, after removing
// whatever the request brought under those names; the server honours them only on a request this connector stamped. A guide stream is refused outright for any route outside the table and for a
// WebSocket: the table is the whole of what a guide may reach, and a route added later is not in it.

// The local headers the connector sets from a guide stream's fields.
const (
	HubGuideBoardHeader = "X-Coral-Hub-Guide-Board"
	HubGuideLabelHeader = "X-Coral-Hub-Guide-Label"
	HubGuideSinceHeader = "X-Coral-Hub-Guide-Since"
)

// HubRoleGuide is the role of a guide beside HubRoleOwner. A stream carries one role: it is never both.
const HubRoleGuide = "guide"

// CapGuideRole is the capability "guide_role/1" in Hello.Capabilities: this Coral knows the guide role. The hub stamps a guide only for a connector that says so, so an older Coral never has a guide
// grant it would treat as an ordinary viewer's.
const CapGuideRole = "guide_role/1"

// maxGuideBoard bounds the board key a guide's stamp carries.
const maxGuideBoard = 128

// ValidGuideBoard reports whether s can be the board of a guide's grant as a stream field: valid text of one to 128 bytes with no control character, slash or backslash. The board is a name the hub
// states; the server compares it exactly with the board in the request's path.
func ValidGuideBoard(s string) bool {
	if s == "" || len(s) > maxGuideBoard || !utf8.ValidString(s) || strings.ContainsAny(s, "/\\") {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return false
		}
	}
	return true
}

// ValidGuideSince reports whether s is the time the grant was accepted: an RFC 3339 UTC time ("2026-10-31T07:00:00Z"), at most 32 bytes. The guide reads the board's messages from this time on.
func ValidGuideSince(s string) bool {
	if len(s) > 32 || !strings.HasSuffix(s, "Z") {
		return false
	}
	_, err := time.Parse(time.RFC3339, s)
	return err == nil
}

// HubGuide is who a guide request is for: the board of the grant, the person's label (hub-user-<8 hex>) and when the grant was accepted (the start of what the guide reads of the board's history).
type HubGuide struct{ Board, Label, Since string }

// Valid reports whether all three parts are well formed. A guide with no start is not a guide: a missing start must never mean "from the beginning".
func (g HubGuide) Valid() bool {
	return ValidGuideBoard(g.Board) && ValidHubUser(g.Label) && ValidGuideSince(g.Since)
}

type hubGuideKey struct{}

// WithHubGuide returns ctx carrying the guide a request is for. Session.RoundTrip sends it with the stream's role. Anything malformed is ignored (and the stream then has no role).
func WithHubGuide(ctx context.Context, board, label, since string) context.Context {
	g := HubGuide{Board: board, Label: label, Since: since}
	if !g.Valid() {
		return ctx
	}
	return context.WithValue(ctx, hubGuideKey{}, g)
}

func hubGuideFrom(ctx context.Context) (HubGuide, bool) {
	g, ok := ctx.Value(hubGuideKey{}).(HubGuide)
	return g, ok
}

// guideStreamOK reports whether a stream's guide fields are consistent: the guide role needs both a valid board and a valid label, the two fields appear with the guide role only, and a guide is never
// also a team member, the hub's service or an owner (a person has one role in a stream).
func (h Header) guideStreamOK() bool {
	guide := h.HubRole == HubRoleGuide
	if !guide {
		return h.GuideBoard == "" && h.GuideLabel == "" && h.GuideSince == ""
	}
	return (HubGuide{Board: h.GuideBoard, Label: h.GuideLabel, Since: h.GuideSince}).Valid() && (h.HubUser == "" || h.HubUser == h.GuideLabel) &&
		h.HubOrg == "" && h.HubTeamRole == "" && h.HubUserID == "" && !h.HubService
}

// guideStamped reports whether the stream is a complete guide stamp.
func guideStamped(h Header) bool { return h.HubRole == HubRoleGuide && h.guideStreamOK() }

type guideRoute struct{ method, pattern string }

// guideRoutes is the closed table of what a guide may reach: exact templates, nothing else (spec S2 and S7). The project in a path is the grant's board: the server answers not-found for any other.
// Every route here is also in the route table (routes.go), so the viewer's tier and the machine's mode apply as to anyone; this table only takes away. The server serves a subset of them until its
// slices land (cloud.GuideServed): a route listed here and not served is refused there.
var guideRoutes = []guideRoute{
	{http.MethodGet, "/api/board/{project}/messages"},
	{http.MethodPost, "/api/board/{project}/messages"},
	{http.MethodGet, "/api/board/{project}/guide-asks"},
	{http.MethodGet, "/api/board/{project}/goals"},
	{http.MethodGet, "/api/board/{project}/goals/{id}"},
	{http.MethodPost, "/api/board/{project}/goals"},
	{http.MethodGet, "/api/board/{project}/artifacts"},
	{http.MethodGet, "/api/artifacts/{hex64}"},
	{http.MethodGet, "/api/artifacts/{hex64}/meta"},
	{http.MethodGet, "/api/artifacts/{hex64}/comments"},
	{http.MethodGet, "/api/artifacts/{hex64}/versions"},
	{http.MethodGet, "/api/artifacts/series/{series_id}"},
	{http.MethodGet, "/api/artifacts/series/{series_id}/versions"},
	{http.MethodPost, "/api/artifacts/{hex64}/comments"},
}

// GuideRouteInfo is one route of the guide table.
type GuideRouteInfo struct{ Method, Pattern string }

// GuideRoutes lists the guide table, for the census tests.
func GuideRoutes() []GuideRouteInfo {
	out := make([]GuideRouteInfo, len(guideRoutes))
	for i, r := range guideRoutes {
		out[i] = GuideRouteInfo{Method: r.method, Pattern: r.pattern}
	}
	return out
}

// IsGuideRoute reports whether (method, decodedPath) is a route of the guide table. HEAD counts as GET.
func IsGuideRoute(method, decodedPath string) bool {
	if method == http.MethodHead {
		method = http.MethodGet
	}
	segs, ok := splitSegments(decodedPath)
	if !ok {
		return false
	}
	for _, r := range guideRoutes {
		if r.method == method && matchGuide(r.pattern, segs) {
			return true
		}
	}
	return false
}

// matchGuide is matchSegments with the two names the guide table adds ({project} and {series_id}, any one segment; {id} a number).
func matchGuide(pattern string, segs []string) bool {
	pat := strings.Split(pattern[1:], "/")
	if len(pat) != len(segs) {
		return false
	}
	for i, ps := range pat {
		switch ps {
		case "{hex64}":
			if !isHex64(segs[i]) {
				return false
			}
		case "{project}", "{series_id}":
			// any one non-empty segment (splitSegments refused empty, dot and backslash ones)
		case "{id}":
			if segs[i] == "" || strings.Trim(segs[i], "0123456789") != "" || len(segs[i]) > 18 {
				return false
			}
		default:
			if ps != segs[i] {
				return false
			}
		}
	}
	return true
}

// stampGuide sets the four guide headers (and the hub user header, to the label, so a write's author is the same value the rest of the server reads) on a request for a guide route whose stream
// carries a complete guide stamp. Any other stream, and any other route, gets none of them: whatever the request itself carried under these names is removed first.
func stampGuide(out http.Header, h Header, method, decodedPath string) {
	out.Del(HubGuideBoardHeader)
	out.Del(HubGuideLabelHeader)
	out.Del(HubGuideSinceHeader)
	if guideStamped(h) && IsGuideRoute(method, decodedPath) {
		out.Set(HubRoleHeader, HubRoleGuide)
		out.Set(HubGuideBoardHeader, h.GuideBoard)
		out.Set(HubGuideLabelHeader, h.GuideLabel)
		out.Set(HubGuideSinceHeader, h.GuideSince)
		out.Del(HubUserHeader)
		out.Set(HubUserHeader, h.GuideLabel)
	}
}

// MatchGuidePattern reports whether decodedPath matches one template of the guide table (the server asks which route of the table a request is).
func MatchGuidePattern(pattern, decodedPath string) bool {
	segs, ok := splitSegments(decodedPath)
	return ok && matchGuide(pattern, segs)
}
