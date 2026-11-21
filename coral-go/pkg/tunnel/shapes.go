package tunnel

import "strings"

// shapeSegment fills a "{}" in a route shape: 64 lowercase hex digits match both a {param}
// and a {hex64} segment.
var shapeSegment = strings.Repeat("0", 64)

// shapeSegment32 fills a "{}" with a {hex32} segment.
var shapeSegment32 = strings.Repeat("0", 32)

// ShapeAllowed reports whether the tunnel lets any request of this route shape through at
// some tier: shape is a path with "{}" for each parameter, as tools/gen_route_queries.py
// writes routes_query.go. The generator lists query parameters only for such routes, so the
// table holds no entry for a route the tunnel refuses (#3942).
func ShapeAllowed(method, shape string) bool {
	// A {} is 64 hex digits (a {hex64} or any {param}) or 32 (a {hex32}, a skill's id): the shape is allowed when either fills it.
	for _, seg := range []string{shapeSegment, shapeSegment32} {
		path := strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(shape, "{}", seg), "{goal}", "goal:coral-go-team:1"), "{diff}", "diff:coral-go-team:agent-12345:0123456789abcdef")
		if Classify(method, path, "") != TierNever || ClassifyService(method, path, "") != TierNever { // a service route (hubservice.go) is the Hub service's: it keeps its query parameters in the table
			return true
		}
	}
	return false
}
