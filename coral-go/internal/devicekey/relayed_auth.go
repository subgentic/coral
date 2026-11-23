package devicekey

import (
	"strings"

	"github.com/subgentic/coral/internal/store"
)

// What a relayed message may do beyond its signature (#20515, Security's conditions on #20513): the Hub person is the one the computer's own stamp names, an owner's key signs only as the owner its link confirmed, and a kind signs
// only its own route.

// Route is one method and path pattern a kind may carry. A {name} segment matches one non-empty segment of the request path; everything else matches exactly.
type Route struct{ Method, Pattern string }

// KindRoutes is the closed table of what each relayed kind may be signed for: the routes of router_pair.go the Hub can reach. A kind with no entry (input-grant, until its route exists) signs nothing the computer will accept.
var KindRoutes = map[Kind][]Route{
	GuideRoster:             {{"PUT", "/api/board/{project}/guide-roster"}},
	OrchestratorGrant:       {{"PUT", "/api/board/{project}/orchestrator-grant"}},
	TrustPreview:            {{"PUT", "/api/artifacts/{id}/trust-preview"}, {"DELETE", "/api/artifacts/{id}/trust-preview"}},
	DailyKnowledgeTeam:      {{"PUT", "/api/teams/detail/{name}/daily-knowledge"}},
	DailyKnowledgeAutoApply: {{"PUT", "/api/teams/detail/{name}/daily-knowledge/auto-apply"}},
	DailyKnowledgeAccept:    {{"POST", "/api/teams/detail/{name}/daily-knowledge/accept"}},
	DailyKnowledgeRevert:    {{"POST", "/api/teams/detail/{name}/daily-knowledge/revert"}},
	SendToAgent:             {{"POST", "/api/sessions/live/{name}/send"}},
	BoardPost:               {{"POST", "/api/board/{project}/messages"}},
	KeepFullAccess:          {{"POST", "/api/sessions/live/{name}/keep-full-access"}},
	HubAutoAccept:           {{"POST", "/api/hub-auto-accept"}},
	GrantMember:             {{"POST", "/api/member-grants"}, {"DELETE", "/api/member-grants/{id}"}},
}

// RoutePath is the path of a signed request target: everything before the query.
func RoutePath(target string) string {
	if i := strings.IndexByte(target, '?'); i >= 0 {
		return target[:i]
	}
	return target
}

// MatchRoute reports whether the kind may be signed for this method and request target, and returns the values of the pattern's {name} segments exactly as signed. A handler of a body-less kind acts only on these (and on the
// query it was signed with), never on a field of its own request that the signature does not cover.
func MatchRoute(k Kind, method, target string) (map[string]string, bool) {
	params, ok := matchPattern(k, method, target)
	if !ok {
		return nil, false
	}
	if k == HubAutoAccept { // the value it sets is in the signed query: any other query (or none) signs nothing the computer will accept (#20649)
		if _, qok := AutoAcceptQuery(target); !qok {
			return nil, false
		}
	}
	return params, true
}

// matchPattern is MatchRoute without the query rule of hub-auto-accept: whether the method and the path are one of the kind's routes.
func matchPattern(k Kind, method, target string) (map[string]string, bool) {
	path := strings.Split(RoutePath(target), "/")
	for _, r := range KindRoutes[k] {
		if r.Method != method {
			continue
		}
		pat := strings.Split(r.Pattern, "/")
		if len(pat) != len(path) {
			continue
		}
		params, ok := map[string]string{}, true
		for i, seg := range pat {
			if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
				if path[i] == "" {
					ok = false
					break
				}
				params[seg[1:len(seg)-1]] = path[i]
			} else if seg != path[i] {
				ok = false
				break
			}
		}
		if ok {
			return params, true
		}
	}
	return nil, false
}

// KindOfRoute is the relayed kind whose route (method and path) this request is, whatever its query: a route no kind lists is not a relayed one, and nothing about it is signed. A request on a kind's route with a query that kind
// does not accept is still that kind's: the check then refuses it (wrong_request), it is never treated as unsigned.
func KindOfRoute(method, target string) (Kind, bool) {
	for _, k := range RelayedKinds {
		if _, ok := matchPattern(k, method, target); ok {
			return k, true
		}
	}
	return "", false
}

// OwnerPinFunc says which Hub label the owner of a link was confirmed as (the owner pin, #20407) and whether one was.
type OwnerPinFunc func(link string) (hubLabel string, confirmed bool)

// RelayedAuthorizer is the authorize function of HandleRelayedOn for a request that came through a Hub link. actor is the Hub person the computer's own link stamp named for this request; pin is the owner pin of the link.
//  1. The signed hub_user equals the stamp's actor: a Hub cannot sign as one person and stamp another. No actor, no message.
//  2. A signer marked as the owner signs only as the owner its link confirmed: the signed hub_user is the pinned label, and a link with no confirmed owner (or no pin function) is refused.
//  3. The signed method and path are one of the routes of the kind's own entry in KindRoutes.
//
// Every refusal is outside_pair or wrong_request; none says which condition failed beyond that.
func RelayedAuthorizer(actor string, pin OwnerPinFunc) func(Relayed, store.DeviceKey) error {
	return func(m Relayed, signer store.DeviceKey) error {
		if actor == "" || m.HubUser != actor {
			return ErrOutsidePair
		}
		if owner, _ := signer.PairState(); owner {
			if pin == nil {
				return ErrOutsidePair
			}
			label, ok := pin(m.Link)
			if !ok || label == "" || label != m.HubUser {
				return ErrOutsidePair
			}
		}
		if _, ok := MatchRoute(m.Kind, m.Method, m.Path); !ok {
			return ErrWrongRequest
		}
		return nil
	}
}
