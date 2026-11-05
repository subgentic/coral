package heavy

import "strings"

// OnMini says whether a pool grant is on the mini: the member's name or its machine says so. The one rule, used by the shell hook (which tells an agent its slot is elsewhere) and by coral-board heavy run (which runs it there).
func OnMini(member, machine string) bool {
	return strings.EqualFold(member, "mini") || strings.EqualFold(machine, "mini")
}
