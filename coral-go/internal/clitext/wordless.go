package clitext

import (
	"strings"
	"unicode"
)

// WordlessGuidance is the refusal, from coral-board and from the server alike (an HTTP or Hub caller reads the same words in the 400's error).
const WordlessGuidance = `this post has no words after the mention, so nothing was sent.
Put the question text in the argument:
  coral-board post --ask "Operator, should I ...?" --yes-no
For long text, write it to a file and use --file:
  coral-board post --ask --file question.md
A lone '-' reads the text from stdin only when it is the only word, as in: coral-board post --ask - <<'EOF' ... EOF (the mention goes inside the text).`

// WordlessMessage is the reason a board post has no words in it, or "" when it has some (#16186). A post whose text, after its @mentions
// and list markers, is empty is refused: `post --ask "@Operator -" <<EOF` sends the literal "-" and drops the heredoc, and the Operator's
// Needs you then shows a bare bullet.
func WordlessMessage(s string) string {
	for _, tok := range strings.Fields(s) {
		if strings.HasPrefix(tok, "@") || listMarker(tok) {
			continue
		}
		for _, r := range tok {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				return ""
			}
		}
	}
	return WordlessGuidance
}

// listMarker is a token that only marks a list item or a heading: -, *, +, a bullet, >, # or "1." and "2)".
func listMarker(tok string) bool {
	body := strings.TrimRight(tok, ".)")
	if body != tok && body != "" {
		allDigits := true
		for _, r := range body {
			if !unicode.IsDigit(r) {
				allDigits = false
			}
		}
		if allDigits {
			return true
		}
	}
	for _, r := range tok {
		if !strings.ContainsRune("-*+•·–—>#_=~`", r) {
			return false
		}
	}
	return true
}
