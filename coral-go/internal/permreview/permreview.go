// Package permreview decides what a permission card may show of an agent's request and whether the person may allow it (#11395, Security's MUST). A card that cuts a long command, or shows text that
// hides what it does (a direction mark that reorders it, a zero-width character, a control character), lets the person allow what they did not read. So: the request is shown whole up to MaxBytes; a request
// that is longer, or holds a control or format character other than a newline or a tab, says so in words and offers ONLY Reject. Every agent's card uses this one rule.
package permreview

import (
	"fmt"
	"strings"
	"unicode"
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
	// Hidden: the request holds a control or format character (Unicode Cc or Cf) other than a newline or a tab, a blank-rendering character (hidden), or a run of BlankRun blanks.
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

// BlankRun is how many blank characters in a row count as hidden: a long run of them pushes what a command does out of the card's sight (a tail after 3,000 spaces).
const BlankRun = 40

// Of reviews one piece of request text. A blank run of BlankRun or more is written "<N blanks>" and counts as hidden.
func Of(text string) Review {
	text = strings.ToValidUTF8(text, "\uFFFD")
	var r Review
	var b strings.Builder
	runes := []rune(text)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		var out string
		switch {
		case blank(c):
			j := i
			for j < len(runes) && blank(runes[j]) {
				j++
			}
			if j-i >= BlankRun {
				r.Hidden = true
				out = fmt.Sprintf("<%d blanks>", j-i)
				i = j - 1
				break
			}
			if hidden(c) {
				r.Hidden = true
				out = fmt.Sprintf("<U+%04X>", c)
			} else {
				out = string(c)
			}
		case hidden(c):
			r.Hidden = true
			out = fmt.Sprintf("<U+%04X>", c)
		default:
			out = string(c)
		}
		if b.Len()+len(out) > MaxBytes {
			r.Cut = true
			break
		}
		b.WriteString(out)
	}
	r.Shown = b.String()
	if r.Cut && !r.Hidden { // text that was cut may hold a hidden character or a blank run beyond the cut: it is not "clean"
		r.Hidden = anyHidden(runes)
	}
	return r
}

// anyHidden says whether the text holds a hidden character or a blank run of BlankRun or more.
func anyHidden(runes []rune) bool {
	run := 0
	for _, c := range runes {
		if hidden(c) {
			return true
		}
		if blank(c) {
			if run++; run >= BlankRun {
				return true
			}
		} else {
			run = 0
		}
	}
	return false
}

// blank is a character that draws as empty space (or as nothing): any white space, and the characters hidden() lists as rendering blank.
func blank(c rune) bool { return unicode.IsSpace(c) || renderBlank(c) }

// renderBlank are characters that draw as nothing but are not Cc or Cf: the Hangul fillers, the Braille blank, the combining grapheme joiner and the Khmer inherent vowels.
func renderBlank(c rune) bool {
	switch c {
	case 0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800, 0x034F, 0x17B4, 0x17B5:
		return true
	}
	return false
}

// hidden is a character a card must not show raw: a control (Cc) or format (Cf) character, a character that renders blank (renderBlank), or a space of any kind other than U+0020 (Zs, Zl, Zp), except a newline and a tab.
func hidden(c rune) bool {
	if c == '\n' || c == '\t' || c == ' ' {
		return false
	}
	return unicode.Is(unicode.Cc, c) || unicode.Is(unicode.Cf, c) || unicode.In(c, unicode.Zs, unicode.Zl, unicode.Zp) || renderBlank(c)
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
