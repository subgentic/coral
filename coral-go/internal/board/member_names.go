package board

import (
	"errors"
	"strings"
	"unicode"
)

// ErrMemberNamePunctuation is a member name that starts or ends with something that is not a letter or a digit (#11687).
var ErrMemberNamePunctuation = errors.New("a name must start and end with a letter or a digit (no colon, comma, bracket, quote or dot at either end)")

// ValidMemberName refuses a name a member could not be addressed by: one whose first or last character, after trimming white space, is not a letter or a digit. "Security Reviewer 2:" joined as it is, and "@Security Reviewer 2" then
// reached the shorter member "Security Reviewer" instead (#11687): punctuation at an end of a name is never part of the name a person types after an @. An empty name is not this rule's to refuse.
func ValidMemberName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	rs := []rune(name)
	if !alnumRune(rs[0]) || !alnumRune(rs[len(rs)-1]) {
		return ErrMemberNamePunctuation
	}
	return nil
}

func alnumRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

// nearerMember is the member a mention that reached the shorter member `matched` was probably meant for: the words after the mention that look like the rest of a longer name (one or two words), when a member's name is
// exactly that longer name apart from the punctuation at its ends ("Security Reviewer 2:" for "@Security Reviewer 2"). "" when there is none, and when the longer name is a member's name exactly (then it was matched whole).
func nearerMember(matched, following string, display []string) string {
	if following == "" || (following[0] != ' ' && following[0] != '\t') {
		return ""
	}
	words, _ := mentionWords(following, 2)
	for k := 1; k <= len(words); k++ {
		cand := strings.ToLower(matched + " " + strings.Join(words[:k], " "))
		for _, d := range display {
			trimmed := strings.ToLower(strings.TrimFunc(d, func(r rune) bool { return !alnumRune(r) }))
			if trimmed == cand && strings.ToLower(d) != cand {
				return d
			}
		}
	}
	return ""
}
