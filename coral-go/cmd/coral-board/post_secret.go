package main

import (
	"fmt"
	"strings"
)

// loginTokenParam is the query parameter of a sign-in link (auth.LoginTokenParam, kept equal by
// TestTheRefusedParamIsTheSignInLinksOwn; coral-board doesn't link the auth package).
const loginTokenParam = "login_token"

// refuseSignInLink refuses a message that carries a sign-in link's token: "login_token=" in any case, or
// URL-encoded as "login_token%3D". A board message is read by every member and kept, so a link pasted
// into one (with a command's whole output) works for anyone who reads it before it lapses. It refuses
// rather than redacts, so the sender sees what happened and posts only the result lines.
func refuseSignInLink(cmdName, message string) error {
	m := strings.ToLower(message)
	if strings.Contains(m, loginTokenParam+"=") || strings.Contains(m, loginTokenParam+"%3d") {
		return fmt.Errorf("error: refusing a message that contains a sign-in link (%s=): anyone who reads the board could sign in with it.\n"+
			"Nothing was posted. Post only the result lines: write them to a file and use coral-board %s --file <file>, never a command's whole output.", loginTokenParam, cmdName)
	}
	return nil
}
