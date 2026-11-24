package tunnel

import (
	"net/http"
	"sync"
	"sync/atomic"
)

// MemberRelayedOpen is false: a Hub's owner cannot yet give or end a member's access (#20883, goal #269). The four routes below are not in the table at all until it is true, so they are `never` exactly
// as before, and the owner marker is not stamped for them. It changes only in a commit Security reads (the design: Security's #20898 item 6); the rest of the change (the signature required by the guard and
// by the handler, the same-link rule, the signer's mode, the notice) ships with it shut. A relayed full grant, one for an agent and the files add-on stay shut by their own gates (board.MemberFullOpen,
// MemberAgentScopeOpen, MemberFilesOpen) whatever this says.
const MemberRelayedOpen = false

var (
	memberRelayedOpen atomic.Bool
	memberRelayedMu   sync.Mutex
)

func init() { memberRelayedOpen.Store(MemberRelayedOpen) }

// MemberRelayedIsOpen reports whether the relayed member-grant routes are in the table now.
func MemberRelayedIsOpen() bool { return memberRelayedOpen.Load() }

// OpenMemberRelayedForTest opens the gate for one test and shuts it when the test ends. Nothing but a test calls it; tests that use it do not run in parallel with each other.
func OpenMemberRelayedForTest(t interface{ Cleanup(func()) }) {
	memberRelayedMu.Lock()
	memberRelayedOpen.Store(true)
	t.Cleanup(func() {
		memberRelayedOpen.Store(MemberRelayedOpen)
		memberRelayedMu.Unlock()
	})
}

// memberRelayedRoutes are the owner's four, Launch tier (a grant can lead to a full one): give and end access on the computer's list and on a team's. Only the Hub's owner is stamped for them
// (OwnerHubOnly) and every one of them needs the relayed owner signature, checked by the guard and again by the handler. The lists (GET) are this computer's alone and are not here.
var memberRelayedRoutes = owner(OwnerHubOnly,
	rules(http.MethodPost, TierLaunch, "/api/member-grants", "/api/board/{project}/member-grants"),
	rules(http.MethodDelete, TierLaunch, "/api/member-grants/{id}", "/api/board/{project}/member-grants/{id}"),
)

// routeTableOpen is the table with those four in front: nothing else in the table names them.
var routeTableOpen = cat(memberRelayedRoutes, routeTable)

// table is the table in force: the base one, or the open one while the gate is open.
func table() []route {
	if memberRelayedOpen.Load() {
		return routeTableOpen
	}
	return routeTable
}
