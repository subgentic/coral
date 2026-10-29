package ptymanager

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// visibleName is s as text safe to show next to a confirm button: control characters, format characters (bidi overrides, zero-width), and line or paragraph separators are dropped, runs of
// white space collapse to one blank, and the result is capped at max runes with an ellipsis. What a process or a folder is called is chosen by whoever made it, and the Operator decides from it.
func visibleName(s string, max int) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case r == ' ' || r == ' ' || unicode.IsControl(r) && !unicode.IsSpace(r) || unicode.Is(unicode.Cf, r):
			continue
		case unicode.IsSpace(r):
			space = b.Len() > 0
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	out := b.String()
	if max > 0 && utf8.RuneCountInString(out) > max {
		rs := []rune(out)
		out = string(rs[:max]) + "…"
	}
	return out
}
