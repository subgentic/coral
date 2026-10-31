package cloud

import (
	"net/http"

	"github.com/subgentic/coral/pkg/tunnel"
)

// The guide role, server half (#11457, pkg/tunnel/hubguide.go). The connector stamps the guide's role, board, label and start on a route of its closed table and nowhere else. This side repeats
// the decision, as Guard does for the route table: a request that says it is a guide in any way (the role header, or any of the three guide headers) is judged here, and everything that is not a
// complete, authentic, single-valued stamp on a route of the table that this server serves is refused. A forged or repeated header is a refusal, never a downgrade to an ordinary viewer.

// guideServed lists the guide-table routes this server answers for a guide, as "METHOD pattern" (the table's own spelling). A route in the table and not in this list is refused: the server's
// slices add theirs as each is built and read.
var guideServed = []string{}

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

// guideAllowed reports whether a request that claims to be a guide's may go on: an authentic complete stamp, a route of the closed table, and a route this server serves for a guide.
func guideAllowed(r *http.Request) bool { return guideAllowedWith(r, guideServed) }

func guideAllowedWith(r *http.Request, served []string) bool {
	if _, ok := GuideCaller(r); !ok {
		return false
	}
	if !tunnel.IsGuideRoute(r.Method, r.URL.Path) {
		return false
	}
	for _, g := range tunnel.GuideRoutes() {
		if r.Method == g.Method || (r.Method == http.MethodHead && g.Method == http.MethodGet) {
			for _, s := range served {
				if s == g.Method+" "+g.Pattern && tunnel.MatchGuidePattern(g.Pattern, r.URL.Path) {
					return true
				}
			}
		}
	}
	return false
}
