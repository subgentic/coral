package main

import (
	"encoding/json"

	"github.com/subgentic/coral/internal/signinguard"
)

// refuseSignInLinkIn refuses text other people read (a task's note, an artifact's name or tags, a comment reply,
// a notification) that carries a sign-in link's token (signinguard). A guard against accidents, not a leak filter.
func refuseSignInLinkIn(what string, texts ...string) error {
	for _, t := range texts {
		if signinguard.Contains(t) {
			return signinguard.Refusal(what, "Send only the result lines, never a command's whole output.")
		}
	}
	return nil
}

// refuseSignInLinkInBody is refuseSignInLinkIn on a request body, as JSON (every apiCall).
func refuseSignInLinkInBody(body any) error {
	if body == nil {
		return nil
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil
	}
	return refuseSignInLinkIn("this command's text", string(data))
}
