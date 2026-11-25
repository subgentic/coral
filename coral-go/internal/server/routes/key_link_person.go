package routes

import "net/http"

// A self-hosted Hub's request key, carried through its key link (#21220), reaches this computer at the link's cap but is never the person (Security's round 1 MUST on #21220; the Orchestrator's
// call on Interact): typing into an agent's terminal (Send, Keys, a terminal or composer frame) and answering its prompt are person acts, refused until the link's own owner stamp step (#21261).
// Everything else its cap allows goes on.

// keyLinkPersonActCode is the closed code of that refusal.
const keyLinkPersonActCode = "key_link_person_act"

const keyLinkPersonActText = "A Hub linked by a request key cannot type into an agent or answer its prompt as the person yet: that comes with Approve through that Hub (#21261)."

// keyLinkCaller is whether r came through a key link (callerKeyLink).
func keyLinkCaller(r *http.Request) bool {
	kind, _ := r.Context().Value(callerKindKey{}).(string)
	return kind == callerKeyLink
}

// refuseKeyLinkPersonAct answers 403 for a key link's person act and reports true; any other caller goes on.
func refuseKeyLinkPersonAct(w http.ResponseWriter, r *http.Request) bool {
	if !keyLinkCaller(r) {
		return false
	}
	writeError(w, http.StatusForbidden, keyLinkPersonActCode, keyLinkPersonActText)
	return true
}
