package agent

import "strings"

// HermesGatewayRefusedIn reports whether a Hermes agent's screen shows Hermes's own refusal to start its gateway: Hermes allows one gateway per host and, when two start in the same moment, one prints
// "Gateway could not start: the gateway exited with status 75" and "Another gateway already owns this host" and its CLI exits, leaving the pane at its shell (#12052). English and Hermes v0.22.5's wording;
// a pane narrower than the lines wraps them, so the text is matched with its white space collapsed. Both phrases must be there: one alone is something else.
func HermesGatewayRefusedIn(screen string) bool {
	low := strings.Join(strings.Fields(strings.ToLower(screen)), " ")
	return strings.Contains(low, "gateway could not start") && strings.Contains(low, "another gateway already owns this host")
}
