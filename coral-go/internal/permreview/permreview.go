// Package permreview decides what a permission card may show of an agent's request and whether the person may allow it (#11395, Security's MUST). A card that cuts a long command, or shows text that
// hides what it does (a direction mark that reorders it, a zero-width character, a control character), lets the person allow what they did not read. So: the request is shown whole up to MaxBytes; a request
// that is longer, or holds a control or format character other than a newline or a tab, says so in words and offers ONLY Reject. Every agent's card uses this one rule.
package permreview

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxBytes is the most of a request a card shows. A longer one is not allowed from the card.
const MaxBytes = 4000

// MaxPatterns is how many patterns a card lists; the rest are counted ("and N more patterns").
const MaxPatterns = 8

// Review is what a card may do with one request's text.
type Review struct {
	// Shown is the text for the card's scrolling box: at most MaxBytes, valid UTF-8, with every hidden character written out as <U+202E> (so the person can see it), never raw.
	Shown string
	// Cut: the request is longer than MaxBytes; Shown ends where it was cut.
	Cut bool
	// Hidden: the request holds a control or format character (Unicode Cc or Cf) other than a newline or a tab.
	Hidden bool
}

// Allowed says the person may allow the request from the card: it was shown whole and holds nothing hidden. Otherwise only Reject is offered, and an Allow answer is refused by the server.
func (r Review) Allowed() bool { return !r.Cut && !r.Hidden }

// Note is the sentence the card shows when the request cannot be allowed from it ("" when it can).
func (r Review) Note() string {
	switch {
	case r.Cut && r.Hidden:
		return fmt.Sprintf("This request is longer than the %d bytes shown and holds characters that can hide what it does (marked <U+....> below). It can only be rejected here: read it in the terminal.", MaxBytes)
	case r.Cut:
		return fmt.Sprintf("This request is longer than the %d bytes shown, so it cannot be allowed from here. Read it in the terminal, or reject it.", MaxBytes)
	case r.Hidden:
		return "This request holds characters that can hide what it does (marked <U+....> below). It can only be rejected here: read it in the terminal."
	}
	return ""
}

// Of reviews one piece of request text.
func Of(text string) Review {
	text = strings.ToValidUTF8(text, "\uFFFD")
	var r Review
	var b strings.Builder
	for _, c := range text {
		if hidden(c) {
			r.Hidden = true
			if b.Len()+len("<U+10FFFF>") > MaxBytes {
				r.Cut = true
				break
			}
			fmt.Fprintf(&b, "<U+%04X>", c)
			continue
		}
		if b.Len()+utf8.RuneLen(c) > MaxBytes {
			r.Cut = true
			break
		}
		b.WriteRune(c)
	}
	r.Shown = b.String()
	if r.Cut { // text that was cut may hold a hidden character beyond the cut: it is not "clean"
		for _, c := range text {
			if hidden(c) {
				r.Hidden = true
				break
			}
		}
	}
	return r
}

// hidden is a character a card must not show raw: a control (Cc) or format (Cf) character, except a newline and a tab.
func hidden(c rune) bool {
	if c == '\n' || c == '\t' {
		return false
	}
	return unicode.Is(unicode.Cc, c) || unicode.Is(unicode.Cf, c)
}

// Patterns reviews a list of patterns the way Of reviews a text: the first MaxPatterns are shown (each reviewed, and the list is Cut when any is), the rest are counted in more.
func Patterns(patterns []string) (shown []string, more int, r Review) {
	for i, p := range patterns {
		pr := Of(p)
		if pr.Cut {
			r.Cut = true
		}
		if pr.Hidden {
			r.Hidden = true
		}
		if i < MaxPatterns {
			shown = append(shown, pr.Shown)
		}
	}
	if len(patterns) > MaxPatterns {
		more = len(patterns) - MaxPatterns
	}
	return shown, more, r
}

// MoreNote is "and N more patterns" ("" for none).
func MoreNote(more int) string {
	switch {
	case more <= 0:
		return ""
	case more == 1:
		return "and 1 more pattern"
	}
	return fmt.Sprintf("and %d more patterns", more)
}

// Merge is the review of several pieces: allowed only when each is.
func Merge(rs ...Review) Review {
	var out Review
	for _, r := range rs {
		out.Cut = out.Cut || r.Cut
		out.Hidden = out.Hidden || r.Hidden
	}
	return out
}
