package cloud

import (
	"net/http"
	"strings"

	"github.com/subgentic/coral/pkg/tunnel"
)

// The guide role, server half (#11457, pkg/tunnel/hubguide.go). The connector stamps the guide's role, board, label and start on a route of its closed table and nowhere else. This side repeats
// the decision, as Guard does for the route table: a request that says it is a guide in any way (the role header, or any of the three guide headers) is judged here, and everything that is not a
// complete, authentic, single-valued stamp on a route of the table that this server serves is refused. A forged or repeated header is a refusal, never a downgrade to an ordinary viewer.

// guideServed lists the guide-table routes this server answers for a guide, as "METHOD pattern" (the table's own spelling). A route in the table and not in this list is refused: the server's
// slices add theirs as each is built and read.
var guideServed = []string{
	"GET /api/board/{project}/messages",
	"POST /api/board/{project}/messages",
	"GET /api/board/{project}/goals",
	"GET /api/board/{project}/goals/{id}",
	"POST /api/board/{project}/goals",
	"GET /api/board/{project}/artifacts",
	"GET /api/artifacts/{hex64}",
	"GET /api/artifacts/{hex64}/meta",
	"GET /api/artifacts/{hex64}/comments",
	"GET /api/artifacts/{hex64}/versions",
	"GET /api/artifacts/series/{series_id}",
	"GET /api/artifacts/series/{series_id}/versions",
	"POST /api/artifacts/{hex64}/comments",
}

// guideQueryKeys are the query parameters a guide's read may carry, per route (the closed filter: nothing else reaches the handler, so a guide cannot steer a read with a parameter the route also takes for
// the owner). A route not listed takes none.
var guideQueryKeys = map[string][]string{
	"GET /api/board/{project}/messages":   {"limit"},
	"GET /api/board/{project}/goals":      {"state", "limit", "cursor"},
	"GET /api/board/{project}/artifacts":  {"tag", "limit", "cursor", "goal"},
	"GET /api/artifacts/{hex64}":          {"v"},
	"GET /api/artifacts/{hex64}/comments": {"state"},
}

// guideClaimed reports whether the request says, by any header, that it is a guide's.
func guideClaimed(r *http.Request) bool {
	for _, k := range []string{tunnel.HubGuideBoardHeader, tunnel.HubGuideLabelHeader, tunnel.HubGuideSinceHeader} {
		if _, ok := r.Header[http.CanonicalHeaderKey(k)]; ok {
			return true
		}
	}
	for _, v := range r.Header.Values(tunnel.HubRoleHeader) {
		if v == tunnel.HubRoleGuide {
			return true
		}
	}
	return false
}

// GuideCaller is the guide a request is for, when it is a request this process's connector really stamped for one: the connector's secret, exactly one role header that says guide, and exactly one
// each of a well formed board, label and start. Anything else is not a guide (and a request that claims to be one is refused by Guard).
func GuideCaller(r *http.Request) (tunnel.HubGuide, bool) {
	if !TunneledAuthentic(r) {
		return tunnel.HubGuide{}, false
	}
	one := func(k string) (string, bool) {
		v := r.Header.Values(k)
		if len(v) != 1 {
			return "", false
		}
		return v[0], true
	}
	role, ok := one(tunnel.HubRoleHeader)
	if !ok || role != tunnel.HubRoleGuide {
		return tunnel.HubGuide{}, false
	}
	board, ok1 := one(tunnel.HubGuideBoardHeader)
	label, ok2 := one(tunnel.HubGuideLabelHeader)
	since, ok3 := one(tunnel.HubGuideSinceHeader)
	g := tunnel.HubGuide{Board: board, Label: label, Since: since}
	if !ok1 || !ok2 || !ok3 || !g.Valid() {
		return tunnel.HubGuide{}, false
	}
	if u := r.Header.Values(tunnel.HubUserHeader); len(u) > 1 || (len(u) == 1 && u[0] != label) {
		return tunnel.HubGuide{}, false // the hub user the connector set is the label, nothing else
	}
	return g, true
}

// guideAllowed reports whether a request that claims to be a guide's may go on: an authentic complete stamp, a route of the closed table, a route this server serves for a guide, only the query
// parameters that route allows, and the grant's own board in the path. A guide asking for another board's path is answered not-found by GuideNotFound, as an unknown route is.
func guideAllowed(r *http.Request) bool { return guideAllowedWith(r, guideServed) }

func guideAllowedWith(r *http.Request, served []string) bool {
	g, ok := GuideCaller(r)
	if !ok || !tunnel.IsGuideRoute(r.Method, r.URL.Path) {
		return false
	}
	method := r.Method
	if method == http.MethodHead {
		method = http.MethodGet
	}
	for _, gr := range tunnel.GuideRoutes() {
		if gr.Method != method || !tunnel.MatchGuidePattern(gr.Pattern, r.URL.Path) {
			continue
		}
		key := gr.Method + " " + gr.Pattern
		servedHere := false
		for _, sv := range served {
			if sv == key {
				servedHere = true
			}
		}
		if !servedHere {
			return false
		}
		allowed := guideQueryKeys[key]
		for k := range r.URL.Query() {
			ok := false
			for _, a := range allowed {
				if a == k {
					ok = true
				}
			}
			if !ok {
				return false
			}
		}
		_ = g
		return true
	}
	return false
}

// GuideNotFound reports whether a guide's request names a board that is not the grant's: the path's board must be exactly the stamped one. Guard answers it as a route that does not exist.
func GuideNotFound(r *http.Request) bool {
	g, ok := GuideCaller(r)
	if !ok {
		return false
	}
	segs := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(segs) >= 3 && segs[0] == "api" && segs[1] == "board" {
		return segs[2] != g.Board
	}
	return false
}
