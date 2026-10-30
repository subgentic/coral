package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"

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

// scanLimit is the largest file whose contents are looked at for a sign-in link before an upload.
const scanLimit = 1 << 20

// warnSignInLinkInFile warns, on stderr, when a file about to be uploaded is text (valid UTF-8 with no NUL
// byte, judged by its contents, not its name) of at most scanLimit bytes and carries a sign-in link's
// parameter. Only a warning: reports and logs legitimately quote the parameter, and the person chose the file.
// It names the file, never the token or the line.
func warnSignInLinkInFile(file string, stderr io.Writer) {
	fi, err := os.Stat(file)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > scanLimit {
		return
	}
	data, err := os.ReadFile(file)
	if err != nil || len(data) > scanLimit || bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return
	}
	if signinguard.Contains(string(data)) {
		fmt.Fprintf(stderr, "warning: %q contains a sign-in link's parameter (%s=). It is uploaded anyway; anyone who can read the artifact could sign in with a link that hasn't lapsed. Upload only the result lines.\n", filepath.Base(file), signinguard.Param)
	}
}
