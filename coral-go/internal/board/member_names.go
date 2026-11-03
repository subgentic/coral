package board

import (
	"errors"
	"strconv"
	"strings"
	"unicode"
)

// ErrMemberNamePunctuation is a member name that starts with something that is not a letter or a digit, or ends with something that is not a letter, a digit or a closing bracket (#11687).
var ErrMemberNamePunctuation = errors.New("a name must start with a letter or a digit and end with a letter, a digit or a closing bracket (no colon, comma, dot, @ or quote at an end)")

// ValidMemberName refuses a name a member could not be addressed by: one whose first character, after trimming white space, is not a letter or a digit, or whose last is not a letter, a digit or a closing ")" or "]" ("Dev (night)" and "QA (2)" are fine). "Security Reviewer 2:" joined as it is, and "@Security Reviewer 2" then
// reached the shorter member "Security Reviewer" instead (#11687): punctuation at an end of a name is never part of the name a person types after an @. An empty name is not this rule's to refuse.
func ValidMemberName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	rs := []rune(name)
	if last := rs[len(rs)-1]; !alnumRune(rs[0]) || !(alnumRune(last) || last == ')' || last == ']') {
		return ErrMemberNamePunctuation
	}
	return nil
}

// ValidMemberNameNear is name with the punctuation ValidMemberName refuses taken off its ends: the start up to a letter or a digit, the end back to a letter, a digit or a closing ")" or "]" ("Dev (x):" gives "Dev (x)").
func ValidMemberNameNear(name string) string {
	rs := []rune(strings.TrimSpace(name))
	for len(rs) > 0 && !alnumRune(rs[0]) {
		rs = rs[1:]
	}
	for len(rs) > 0 {
		if last := rs[len(rs)-1]; alnumRune(last) || last == ')' || last == ']' {
			break
		}
		rs = rs[:len(rs)-1]
	}
	return string(rs)
}

// MemberNameHint is the clause that follows "X is not a member of this team" when no member could have the name X (ValidMemberName refuses it): the rule, and the nearest valid name when anything is left of it. "" for a valid name.
func MemberNameHint(name string) string {
	if ValidMemberName(name) == nil {
		return ""
	}
	h := " (a member's name starts with a letter or a digit and ends with a letter, a digit, or a closing ) or ]"
	if near := ValidMemberNameNear(name); near != "" {
		h += "; did you mean " + strconv.Quote(near) + "?"
	}
	return h + ")"
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
