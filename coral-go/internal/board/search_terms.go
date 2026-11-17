package board

import (
	"sort"
	"strings"
)

// SearchTerms is what a search text asks for (#19423): each word on its own, and a "quoted phrase" as one term, all lower-cased and each once.
// A hit holds every term, in any order and in any field; the same reading the past-chat search has always had. A text with no space is one term, so a
// single word or an exact phrase behaves as it did.
func SearchTerms(raw string) []string {
	var terms []string
	seen := map[string]bool{}
	add := func(t string) {
		t = strings.ToLower(strings.TrimSpace(t))
		if t != "" && !seen[t] {
			seen[t] = true
			terms = append(terms, t)
		}
	}
	var cur strings.Builder
	inQuote := false
	flush := func() {
		if inQuote {
			add(cur.String())
		} else {
			for _, w := range strings.Fields(cur.String()) {
				add(w)
			}
		}
		cur.Reset()
	}
	for _, r := range raw {
		if r == '"' {
			flush()
			inQuote = !inQuote
			continue
		}
		cur.WriteRune(r)
	}
	flush()
	if len(terms) == 0 {
		if t := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(raw, `"`, " "))); t != "" {
			terms = append(terms, t)
		}
	}
	return terms
}

// longestFirst puts the longest term first (the rarest, so the one that narrows a scan or an index most), keeping the others' order.
func longestFirst(terms []string) []string {
	out := append([]string(nil), terms...)
	sort.SliceStable(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}

// hasAllTerms says every term is somewhere in the fields (case-insensitive).
func hasAllTerms(terms []string, fields ...string) bool {
	for _, t := range terms {
		found := false
		for _, f := range fields {
			if strings.Contains(strings.ToLower(f), t) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// WorkRank orders hits of a several-term search: 2 when the terms stand together as typed in some field, plus 1 when every term is in the title. A one-term search ranks every hit 0 (newest first, as before).
func WorkRank(terms []string, title string, fields ...string) int {
	if len(terms) < 2 {
		return 0
	}
	rank := 0
	phrase := strings.Join(terms, " ")
	for _, f := range fields {
		if strings.Contains(strings.ToLower(strings.Join(strings.Fields(f), " ")), phrase) {
			rank = 2
			break
		}
	}
	if hasAllTerms(terms, title) {
		rank++
	}
	return rank
}
