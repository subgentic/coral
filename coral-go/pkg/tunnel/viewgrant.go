package tunnel

import (
	"net/http"
	"strings"
)

// viewGrantRoutes is the closed list of routes a Hub person who holds only a View grant may call (#20581 a, Security V1): GET only, each one named, each one scoped to a board by its {project} segment so the computer can check it against
// the grant's own board. Everything not here is refused for such a person, however low its tier: a new route is out until someone adds it here and to the census test. It is the board's messages and nothing more for now: the
// agent list and status rows still carry fields a View person must not see (an agent's last message, its folder), and they wait for a typed answer built on this computer (V2).
var viewGrantRoutes = []string{
	"/api/board/{project}/messages",
}

// ViewGrantRoutes returns the closed list, for the census.
func ViewGrantRoutes() []string { return append([]string(nil), viewGrantRoutes...) }

// ViewGrantBoard says whether a request is on the View list and, if so, which board it asks for: the {project} of its path. It is false for any method but GET (HEAD reads like GET), for a route not on the list, and for one the table
// does not give the View tier.
func ViewGrantBoard(method, decodedPath string) (board string, ok bool) {
	if method == http.MethodHead {
		method = http.MethodGet
	}
	if method != http.MethodGet {
		return "", false
	}
	pattern, tier, found := RuleFor(method, decodedPath)
	if !found || tier != TierView {
		return "", false
	}
	listed := false
	for _, p := range viewGrantRoutes {
		if p == pattern {
			listed = true
			break
		}
	}
	if !listed {
		return "", false
	}
	pp, rp := strings.Split(strings.Trim(pattern, "/"), "/"), strings.Split(strings.Trim(decodedPath, "/"), "/")
	if len(pp) != len(rp) {
		return "", false
	}
	for i, seg := range pp {
		if seg == "{project}" {
			return rp[i], rp[i] != ""
		}
	}
	return "", false // a listed route with no board in it names no scope: refused
}
