package tmux

// NoticeVerdict is whether a board notice may be typed into an agent's terminal now.
type NoticeVerdict struct {
	OK bool
	// Wait: the agent's process is still being recorded (the launch is a moment old): nothing is typed yet, and the sender tries again.
	Wait bool
	// Reason says why not (one of the Reason constants); "" when OK.
	Reason string
}

// The reasons a notice is not typed (NoticeVerdict.Reason). They are also what the log says, once per cause.
const (
	ReasonAdopting    = "the agent is starting: its process is not recorded yet"
	ReasonNotRecorded = "the agent's process is not recorded"
	ReasonGone        = "the agent's process has ended"
	ReasonBackground  = "the agent is not in the terminal's foreground"
	ReasonForeground  = "the terminal's foreground program is not the agent"
)
