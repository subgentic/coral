package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/signinguard"
)

// refuseSignInLink refuses a post or send whose message carries a sign-in link's token (signinguard), from
// the arguments, --file or stdin alike: a board message is read by every member and kept. A guard against
// accidents (a command's whole output pasted into a post), not a leak filter.
func refuseSignInLink(cmdName, message string) error {
	if signinguard.Contains(message) {
		return signinguard.Refusal("a message", "Post only the result lines: write them to a file and use coral-board "+cmdName+" --file <file>, never a command's whole output.")
	}
	return nil
}

// refuseSignInLinkInBody is the same check on every request body coral-board sends: task and goal text,
// titles, notes, reviews and answers alike, so a command with no check of its own still can't put a link
// where members read it. It exits 1, having sent nothing.
func refuseSignInLinkInBody(body any) {
	if body == nil {
		return
	}
	data, err := json.Marshal(body)
	if err != nil || !signinguard.Contains(string(data)) {
		return
	}
	fmt.Fprintln(os.Stderr, signinguard.Refusal("this command's text", "Send only the result lines, never a command's whole output."))
	clierr.Exit1()
}
