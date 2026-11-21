package tunnel

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// Hub parity batch B (#20258, coral-hub's ask #256265, section B): the small writes whose handler answers the Hub owner.
var parityBRows = []struct{ method, pattern string }{
	{"POST", "/api/agents/models/refresh"},
	{"POST", "/api/folder-tags/{folderName}"},
	{"POST", "/api/sessions/history/{sessionID}/tags"},
	{"POST", "/api/sessions/live/{name}/tasks/reorder"},
	{"POST", "/api/sessions/live/{name}/waiting/dismiss"},
	{"POST", "/api/tags"},
	{"PUT", "/api/sessions/history/{sessionID}/notes"},
	{"PUT", "/api/themes/{name}"},
}

func TestTheClassBWriteRowsAreOwnerRowsAtInteract(t *testing.T) {
	for _, r := range parityBRows {
		path := parityAPath(r.pattern)
		name := r.method + " " + r.pattern
		assert.Equal(t, TierInteract, Classify(r.method, path, ""), name)
		pattern, mode := OwnerRoute(r.method, path)
		assert.Equal(t, r.pattern, pattern, name+": its own row, not a neighbour's")
		assert.Equal(t, OwnerRefuse, mode, name+": the owner's alone")
		assert.Equal(t, TierNever, ClassifyService(r.method, path, ""), name+": not the Hub service's")
		assert.Equal(t, TierNever, Classify(r.method, path, "zz_unknown=1"), name+": a query key the handler does not read is refused")
		assert.NotEqual(t, r.pattern, firstPattern(r.method, path+"/x1"), name+": a longer path")
	}
}

// heldForTheirHandlerB are the section B writes whose handler (or an older never rule of this table) answers the Hub owner with its own refusal, so a row would reach nothing: they stay never until Security and
// the Orchestrator decide to lift that refusal, route by route.
var heldForTheirHandlerB = []struct{ method, path string }{
	{"PATCH", "/api/sessions/history/x1/flags"}, // never since #7809: the mailbox state is local only
	{"POST", "/api/artifacts/retention/ack"},    // operator_only
	{"POST", "/api/board/x1/health/ack"},        // never through the Hub (healthAdmin)
	{"POST", "/api/reminders"},                  // not_available_through_hub (chiefLocal)
	{"POST", "/api/reminders/agents/x1/switch"}, // not_available_through_hub
	{"POST", "/api/reminders/x1/done"},          // not_available_through_hub
	{"POST", "/api/resources/entries/x1/move"},  // manager_only
	{"POST", "/api/resources/x1/claim"},         // an agent's own identity, named by the body
	{"POST", "/api/resources/x1/release"},       // an agent's own identity, named by the body
	{"POST", "/api/resources/x1/renew"},         // an agent's own identity, named by the body
	{"PUT", "/api/resources/x1"},                // manager_only
	{"POST", "/api/views"},                      // local dashboard only
	{"PUT", "/api/views/x1"},                    // local dashboard only
	{"PUT", "/api/board/x1/working-mode/presets/x2"},
	{"POST", "/api/board/x1/working-mode/presets/x2/reset"}, // hub.md: never reachable through the tunnel
	{"POST", "/api/board/x1/goal-requests"},                 // the handler takes the actor's name from the body
	{"POST", "/api/board/x1/goal-requests/x2/accept"},       // the handler takes the actor's name from the body
	{"POST", "/api/board/x1/goal-requests/x2/decline"},      // the handler takes the actor's name from the body
	{"POST", "/api/board/x1/messages/mark-read"},            // the handler takes the subscriber's name from the body // operator_identity_required
}

func TestTheWritesWhoseHandlerRefusesTheHubOwnerHaveNoRowYet(t *testing.T) {
	for _, c := range heldForTheirHandlerB {
		assert.Equal(t, TierNever, Classify(c.method, c.path, ""), c.method+" "+c.path)
		assert.Equal(t, TierNever, ClassifyService(c.method, c.path, ""), c.method+" "+c.path)
		if _, m := OwnerRoute(c.method, c.path); m != OwnerNone {
			assert.Failf(t, "has an owner row", "%s %s", c.method, c.path)
		}
	}
}
