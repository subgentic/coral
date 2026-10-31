package routes

import (
	"fmt"
	"unicode"
)

// What auto-accept judges of a pending tool (#11399). The pending tool the chat shows is cut (a command at 4,000 bytes, a path at 1,000, a value over its limit dropped), but the risk rules must read the WHOLE
// command or path: a harmful part after the cut would never be seen, and the request would be allowed. So the whole text of each judged field is kept beside the shown one (never served), up to riskMaxBytes;
// anything that cannot be judged whole (longer than that, not text, or holding a character that hides what it does) is recorded as Unjudged, and auto-accept refuses it: it is left to the person.

// riskMaxBytes is the most of one field auto-accept will read. A longer command is not auto-accepted.
const riskMaxBytes = 64 << 10

// riskBlankRun is how many blank characters in a row count as hiding what follows (a tail after thousands of spaces).
const riskBlankRun = 40

// riskKeys are the tool input fields the risk rules read.
var riskKeys = []string{"command", "CommandLine", "file_path", "notebook_path", "path", "TargetFile", "AbsolutePath"}

// riskInputOf keeps the whole text of each judged field and says why the request cannot be judged ("" when it can).
func riskInputOf(in map[string]any) (whole map[string]string, unjudged string) {
	for _, k := range riskKeys {
		v, ok := in[k]
		if !ok || v == nil {
			continue
		}
		s, isText := v.(string)
		switch {
		case !isText:
			if unjudged == "" {
				unjudged = fmt.Sprintf("the tool's %s is not plain text, so it cannot be judged", k)
			}
		case len(s) > riskMaxBytes:
			if unjudged == "" {
				unjudged = fmt.Sprintf("the tool's %s is longer than %d bytes, so it cannot be judged", k, riskMaxBytes)
			}
		default:
			if whole == nil {
				whole = map[string]string{}
			}
			whole[k] = s
			if unjudged == "" && hidesText(s) {
				unjudged = fmt.Sprintf("the tool's %s holds a character that can hide what it does, so it cannot be judged", k)
			}
		}
	}
	return whole, unjudged
}

// hidesText says whether s holds a control or format character (other than a newline or a tab), a character that draws as space or nothing, or a run of riskBlankRun blanks.
func hidesText(s string) bool {
	run := 0
	for _, c := range s {
		if riskHidden(c) {
			return true
		}
		if unicode.IsSpace(c) || riskRenderBlank(c) {
			if run++; run >= riskBlankRun {
				return true
			}
		} else {
			run = 0
		}
	}
	return false
}

// riskHidden is a character a card must not show raw: Cc or Cf, any space other than U+0020, a newline or a tab, or one that renders blank.
func riskHidden(c rune) bool {
	if c == '\n' || c == '\t' || c == ' ' {
		return false
	}
	return unicode.Is(unicode.Cc, c) || unicode.Is(unicode.Cf, c) || unicode.In(c, unicode.Zs, unicode.Zl, unicode.Zp) || riskRenderBlank(c)
}

// riskRenderBlank are characters that draw as nothing but are neither Cc nor Cf: the Hangul fillers, the Braille blank, the combining grapheme joiner and the Khmer inherent vowels.
func riskRenderBlank(c rune) bool {
	switch c {
	case 0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800, 0x034F, 0x17B4, 0x17B5:
		return true
	}
	return false
}
