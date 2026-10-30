package routes

import (
	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// What happens, after an update's relaunch or install, to each agent it restarts: the update dialog says it per agent, and the
// operator saw "not known whether it starts again" for all of them, because nothing told it. Coral's own shutdown marks each one
// asleep (coral_stopped), and the next start wakes them by auto_wake.go's rule, so the answer here comes from that rule's own inputs:
// the "Wake agents after a restart" setting, its cap, how many agents restart, and whether the agent's CLI resumes its conversation.
const (
	afterWakes       = "wakes"            // woken at the next start, in its own conversation
	afterAsks        = "asks"             // more agents than the cap: the dashboard asks before waking them
	afterStaysAsleep = "stays_asleep"     // the setting is off: asleep until someone wakes it
	afterNewConv     = "new_conversation" // woken, but its CLI can't resume, so a new conversation
	afterNewTerminal = "new_terminal"     // a plain terminal: woken as a fresh shell
)

// afterRestart sets After on each agent. total is how many agents restart (all of them, before the list shown is cut to its rows).
// The crash-loop guard (auto_wake.go's autoWakeGuarded) can't be known in advance, so the dialog's summary says that in words.
func afterRestart(agents []RestartAgent, total int, settings map[string]string) {
	on, limit := autoWakeOn(settings), autoWakeCap(settings)
	for i := range agents {
		switch {
		case !on:
			agents[i].After = afterStaysAsleep
		case total > limit:
			agents[i].After = afterAsks
		case agents[i].AgentType == at.Terminal:
			agents[i].After = afterNewTerminal
		case !agent.GetAgent(agents[i].AgentType).SupportsResume():
			agents[i].After = afterNewConv
		default:
			agents[i].After = afterWakes
		}
	}
}
