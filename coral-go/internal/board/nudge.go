package board

import "fmt"

// NudgeText is the one line Coral types into an agent to tell it unread messages wait on the board.
func NudgeText(unread int) string {
	plural := "s"
	if unread == 1 {
		plural = ""
	}
	return fmt.Sprintf("You have %d unread message%s on the message board. Run 'coral-board read' to see them.", unread, plural)
}
