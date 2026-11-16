package board

// NudgeText is the one line Coral types into an agent to tell it unread messages wait on the board. It states no number: the count that decides a nudge is the notifier's (messages that tag the member, Coral's own
// notices to it), a plain read returns more or other messages in places (a queue line, an orchestrator's wider read), and a number typed there was sometimes not what the read then returned (#18753).
func NudgeText() string {
	return "You have unread messages on the message board. Run 'coral-board read' to see them."
}
