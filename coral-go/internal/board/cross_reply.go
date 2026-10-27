package board

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// How to answer a message from another board (#9054): built here, by the server, so every place that shows a message (coral-board read, its --json, the board nudge, the
// dashboard's board view) says the same thing and no client works the command out from the envelope.
//
//	another team on this Coral:  Reply with: coral-board send --board <team> --reply-to <id> "..."
//	a team on another Coral, over Coral Hub:  Reply with: coral-board send --address <server>/<team> --reply-to <id> "..."

var (
	hexOnly     = regexp.MustCompile(`^[0-9a-f]+$`)
	plainTeamRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

// CrossReplyLine is the line that tells a reader how to answer message id, or "" when the message is not an inbound one from another board (an ordinary message, the sender's
// own outbound copy, a message with an envelope this cannot read). A board name that is not a plain name (spaces, quotes) is quoted for the shell.
func CrossReplyLine(external RawJSON, id int64) string {
	if len(external) == 0 || id <= 0 {
		return ""
	}
	var o MessageOrigin
	if json.Unmarshal(external, &o) != nil || o.Direction != "inbound" || o.Board == "" {
		return ""
	}
	if !o.remote() {
		return fmt.Sprintf("Reply with: coral-board send --board %s --reply-to %d \"...\"", shellWord(o.Board), id)
	}
	// Another Coral, through Coral Hub: the address is the server then the team. The hub's own name for the server is not in the message, only the server's id, and an
	// address takes "id-" and the first 12 hex digits of that id (the form `coral-board targets` lists when the hub has no name for it).
	hex := strings.ToLower(strings.ReplaceAll(o.ServerID, "-", ""))
	if len(hex) < 12 || !hexOnly.MatchString(hex[:12]) || !plainTeamRe.MatchString(o.Board) {
		return fmt.Sprintf("Reply with: coral-board send --address <server>/<team> --reply-to %d \"...\" (the sender's address is in  coral-board targets)", id)
	}
	return fmt.Sprintf("Reply with: coral-board send --address id-%s/%s --reply-to %d \"...\"", hex[:12], o.Board, id)
}

// shellWord is s as one shell word: as it is when it is plain, else in single quotes.
func shellWord(s string) string {
	if plainTeamRe.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
