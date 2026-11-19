// Package devicekey is the pure part of Coral's device keys (#19669, design page v4, coral-hub wire format draft 7): the label rule, the encodings and the one canonical byte form of a signed message. It holds no state and
// reads no clock; the device list is internal/store and the checks of a message against it are the verifier's (slice 3).
package devicekey

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// LabelMaxBytes is the longest label, in bytes.
const LabelMaxBytes = 64

// CleanLabel is the cleaned form the Hub applies to every label: Unicode NFKC, then Go strings.TrimSpace (which trims Unicode White_Space).
func CleanLabel(s string) string { return strings.TrimSpace(norm.NFKC.String(s)) }

// LabelOK is the one label rule, the same on the Hub, the page and Coral: 1 to 64 BYTES of valid UTF-8, no rune of class Cc, Cf, Zl, Zp, Co or Cs, no U+FFFD, and already in the cleaned form (a label that changes under
// CleanLabel would change the string a MAC or a signature covers).
func LabelOK(s string) bool {
	if len(s) == 0 || len(s) > LabelMaxBytes || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r == utf8.RuneError || unicode.In(r, unicode.Cc, unicode.Cf, unicode.Zl, unicode.Zp, unicode.Co, unicode.Cs) {
			return false
		}
	}
	return CleanLabel(s) == s
}
