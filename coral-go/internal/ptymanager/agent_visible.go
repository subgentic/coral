package ptymanager

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// visibleName is s as text safe to show next to a confirm button: control characters, format characters (bidi overrides, zero-width), and line or paragraph separators are dropped, runs of
// white space collapse to one blank, and the result is capped at max runes with an ellipsis. What a process or a folder is called is chosen by whoever made it, and the Operator decides from it.
func visibleName(s string, max int) string { return visibleCapped(s, max, false) }

// visibleTail is visibleName that keeps the END when it must cut, with a leading ellipsis: the end of a path is what tells two folders apart.
func visibleTail(s string, max int) string { return visibleCapped(s, max, true) }

func visibleCapped(s string, max int, tail bool) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case r == '\u2028' || r == '\u2029' || unicode.IsControl(r) && !unicode.IsSpace(r) || unicode.Is(unicode.Cf, r):
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
		if tail {
			return "…" + string(rs[len(rs)-max:])
		}
		out = string(rs[:max]) + "…"
	}
	return out
}
