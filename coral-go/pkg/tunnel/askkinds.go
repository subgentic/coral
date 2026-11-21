package tunnel

import "strings"

// The asks a Hub may answer for the Operator, per link (#20413, Security's gate item c). The vocabulary is closed: a kind that is not here cannot be stored, listed or allowed, by a Hub or by the person at this
// computer. A permission prompt, a custom-check approval, a device-key approval and an approved proposal (work agents run) are not in it and have no route a Hub can answer them through.
const (
	AskKindAgentAsk     = "agent_ask"     // a question an agent put to the Operator: answer, dismiss, images
	AskKindAskButton    = "ask_button"    // a button of a board ask (claim, settle) and closing a board ask
	AskKindMessageReply = "message_reply" // a post that answers an ask by reply_to (decided by the handler, from its own record, not by the path)
)

// AskKindLocalOnly marks a route that settles something agents will run (approving or rejecting a proposal): it is not in the vocabulary, so an added link never passes it, whatever its list says. The
// enrollment's own link is unchanged.
const AskKindLocalOnly = "local_only"

// AskKinds is the vocabulary, in a stable order.
func AskKinds() []string { return []string{AskKindAgentAsk, AskKindAskButton, AskKindMessageReply} }

// ValidAskKind says kind is in the vocabulary.
func ValidAskKind(kind string) bool {
	for _, k := range AskKinds() {
		if k == kind {
			return true
		}
	}
	return false
}

// askRoutes is the closed table of the routes that answer or close an ask, by method and path pattern ({x} matches one segment). A route that answers an ask must be in it: a test fails until a new one is
// mapped (askRouteKinds is listed there against the route golden). message_reply is not here: POST /api/board/{project}/messages is also an ordinary post, and the handler decides.
var askRoutes = []struct{ method, pattern, kind string }{
	{"POST", "/api/agent-asks/{id}/answer", AskKindAgentAsk},
	{"POST", "/api/agent-asks/{id}/dismiss", AskKindAgentAsk},
	{"POST", "/api/agent-asks/{id}/images", AskKindAgentAsk},
	{"POST", "/api/board/{project}/asks/{id}/buttons/{id}/claim", AskKindAskButton},
	{"POST", "/api/board/{project}/asks/{id}/buttons/{id}/settle", AskKindAskButton},
	{"POST", "/api/board/{project}/asks/{id}/close", AskKindAskButton},
	{"POST", "/api/board/{project}/proposals/{id}/approve", AskKindLocalOnly},
	{"POST", "/api/board/{project}/proposals/{id}/reject", AskKindLocalOnly},
	// A decision on a file sent for review closes the questions that carry its id (settleAsksAbout), and approving a plan or a release is the Operator's own: it stays at this computer for an added link.
	{"POST", "/api/board/{project}/artifacts/{id}/review", AskKindLocalOnly},
	{"PUT", "/api/board/{project}/artifacts/{id}/review", AskKindLocalOnly},
	{"DELETE", "/api/board/{project}/artifacts/{id}/review", AskKindLocalOnly},
}

// AskRoutePatterns lists the routes of the table as "METHOD pattern", for the test that holds it against the server's routes.
func AskRoutePatterns() []string {
	out := make([]string, 0, len(askRoutes))
	for _, r := range askRoutes {
		out = append(out, r.method+" "+r.pattern)
	}
	return out
}

// AskRouteKind is the ask kind a request answers by its method and path, "" when the route is not one that answers an ask.
func AskRouteKind(method, path string) string {
	segs := strings.Split(strings.Trim(path, "/"), "/")
	for _, r := range askRoutes {
		if r.method != method {
			continue
		}
		ps := strings.Split(strings.Trim(r.pattern, "/"), "/")
		if len(ps) != len(segs) {
			continue
		}
		ok := true
		for i, p := range ps {
			if strings.HasPrefix(p, "{") {
				ok = ok && segs[i] != ""
			} else {
				ok = ok && p == segs[i]
			}
		}
		if ok {
			return r.kind
		}
	}
	return ""
}
