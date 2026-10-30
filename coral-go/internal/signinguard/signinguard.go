// Package signinguard keeps a dashboard sign-in link out of text that other people read: board posts,
// task and goal text, artifact names, notifications. A link pasted there (with a command's whole output)
// works for anyone who reads it before it lapses. It is a guard against accidents, not a leak filter:
// it looks only for the link's parameter, and anyone who means to share a token can still write it
// another way.
package signinguard

import (
	"fmt"
	"strings"
)

// Param is the query parameter of a sign-in link (auth.LoginTokenParam, kept equal by a test; the
// command-line tools that use this package don't link the auth package).
const Param = "login_token"

// Contains reports whether text carries a sign-in link's token: "login_token=" in any case, or
// URL-encoded as "login_token%3D".
func Contains(text string) bool {
	t := strings.ToLower(text)
	return strings.Contains(t, Param+"=") || strings.Contains(t, Param+"%3d")
}

// Refusal is the error for text that Contains a token. what names the text ("a message", "the task's
// text"), hint how to send only the result instead. It refuses rather than redacts, so the sender sees
// it, and it never repeats the token.
func Refusal(what, hint string) error {
	return fmt.Errorf("error: refusing %s that contains a sign-in link (%s=): anyone who reads it could sign in with it.\n"+
		"Nothing was sent. %s\n"+
		"To talk about the parameter, write it without '='.", what, Param, hint)
}
