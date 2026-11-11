package routes

import (
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// notInNeedsYouNote is what an agent is told, in the post's own answer, when its post waits on the Operator but is not a question to them (#15304, walk 18 H2): "Done, please check" in a plain @Operator post
// reached nobody's Needs you, and the board's check only said so ten minutes later.
const notInNeedsYouNote = `this post waits on the Operator but is not in their Needs you: a plain @mention does not put it there. Post it again with  coral-board post --ask "@Operator ..."  (or upload the file tagged "for review").`

// notInNeedsYou reports whether a post just stored by an agent waits on the Operator (its words, board.WaitsOnOperator) and is no question to them. A file linked in the post may be tagged "for review" (the board's
// check reads the tags later), so a post that links one is not told; Coral's own posts, the Operator's, a person's through the dashboard and another Coral's are never told.
func notInNeedsYou(msg *board.Message, human bool) bool {
	if msg == nil || human || msg.IsSystem || msg.Origin != nil || board.IsOperatorName(msg.SubscriberID) {
		return false
	}
	if msg.Ask != nil || !board.WaitsOnOperator(msg.Content) {
		return false
	}
	return !strings.Contains(msg.Content, "coral://artifacts/")
}
