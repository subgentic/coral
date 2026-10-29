package board

import (
	"strings"
	"unicode"
)

// typedLabelMax is the longest a label in a typed notice may be, in runes: a notice names a thing, and the reader looks it up for the rest.
const typedLabelMax = 80

// TypedLabel is a short piece of text someone else wrote (a task title, a subscriber's name, a board name) made fit to be TYPED into an
// agent's terminal as part of a notice (goal #7, #378). That terminal may not be the agent's CLI: an exited agent leaves a shell there,
// and a person can start another one (cmd, bash, PowerShell). So a label keeps only letters, digits, spaces and . , : _ - /; every
// other character, each one that a shell reads (quotes, $ ( ) ; & | < > ^ % ` { } [ ] @ # ! * ~ \ and the Unicode quotes and dashes
// PowerShell takes as ASCII ones), becomes a space. Spaces are collapsed, the ends trimmed, and a long label is cut at typedLabelMax
// runes with "...". "" stays "". The text itself is never lost: notices name the id, and coral-board shows the whole text.
func TypedLabel(s string) string {
	return typedOnly(s, ".,:_-/", typedLabelMax)
}

// TypedText is TypedLabel for a long line Coral composed around other people's words (the team health check, which quotes what agents
// said): the same characters, plus '#' so "#12" keeps naming a task, cut at typedTextMax runes. A typed line built with it must still
// start with one of the fixed openers (TypedOpeners), so the '#' never begins it.
func TypedText(s string) string {
	return typedOnly(s, ".,:_-/#", typedTextMax)
}

// typedTextMax is the longest a composed typed line's text may be, in runes (Security on goal #7): the health check's full text is for
// the board, the typed line only has to say what to look at.
const typedTextMax = 600

// TypedOpeners are the first words a typed notice may start with. None is a program, a cmdlet or an alias here (checked by the
// typed-notice census), and none is a label: in cmd.exe a line's first word is what runs, and in PowerShell a bare first word is a command.
var TypedOpeners = []string{"You", "[Task", "[Wait", "[Coral"}

// typedLetter is a letter a label keeps: upper, lower, title case and other letters (Lu, Ll, Lt, Lo), not the modifier letters (Lm),
// some of which Windows best-fits to ASCII punctuation (an apostrophe, a caret) when a console reads them (the coral-go-team's Security on #210).
func typedLetter(r rune) bool {
	return unicode.In(r, unicode.Lu, unicode.Ll, unicode.Lt, unicode.Lo)
}

// typedOnly keeps letters, digits and the extra characters, turns every other run into one space, trims the ends, and cuts at max runes
// with "..." (0: no cap).
func typedOnly(s, extra string, max int) string {
	var b strings.Builder
	b.Grow(len(s))
	space := true // drops leading spaces
	n := 0
	for _, r := range s {
		keep := typedLetter(r) || unicode.IsDigit(r) || strings.ContainsRune(extra, r)
		if !keep {
			if !space {
				b.WriteByte(' ')
				space = true
				n++ // the cap counts every rune written
			}
			continue
		}
		if max > 0 && n >= max {
			return strings.TrimRight(b.String(), " ") + "..."
		}
		b.WriteRune(r)
		space = false
		n++
	}
	return strings.TrimRight(b.String(), " ")
}
