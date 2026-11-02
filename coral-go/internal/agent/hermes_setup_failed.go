package agent

import "strings"

// HermesSetupFailedIn reports whether a Hermes agent's screen shows that its first-use setup failed: Hermes prepares its Python dependencies the first time a home runs, and when that cannot finish (a fetch from the
// package index timed out) it prints "no dependency environment is committed for this install" and its CLI exits (#12213). English and Hermes v0.22.5's wording, with white space collapsed for a narrow pane. Only the
// failure's own sentence counts: the "preparing dependencies" line is shown while setup is running and means nothing by itself. The caller reads it only for an agent already back at its shell.
func HermesSetupFailedIn(screen string) bool {
	low := strings.Join(strings.Fields(strings.ToLower(screen)), " ")
	return strings.Contains(low, "no dependency environment is committed for this install")
}
