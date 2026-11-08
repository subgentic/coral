package routes

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Claude's "Claude wants to use your browser" menu (#14151, the Beta Tester's inbox-only run): three rows with a cursor mark and a one-line description each, NO numbers
// and NO "Enter to confirm" footer, so parseUnnumberedMenu does not read it and a Needs you row could only say "cannot be answered with one choice here".
//
// It is read here by structure and nothing else: the dialog's own title line, then the three rows in this order and these labels, exactly one of them marked, and
// nothing after the last row but blank lines. Any other text, label, count or order is not this menu, and the row keeps its old behaviour (Open agent). The labels are
// the whole answer the row may take: "Not now" (a one-time No: Claude goes on without browser tools); "Install extension" opens the person's Chrome and "Don't ask
// again" is a lasting choice, so neither is ever offered as a button (the client draws only Not now, and says why the others are left to Open agent).
const (
	browserPromptTitle  = "Claude wants to use your browser"
	browserInstallLabel = "Install extension"
	browserNotNowLabel  = "Not now"
	browserNeverLabel   = "Don't ask again"
)

var (
	browserRowRe  = regexp.MustCompile(`^(\s*)([❯›>])?\s*(\S.*?)(?:\s{2,}(\S.*?))?\s*$`)
	browserLabels = []string{browserInstallLabel, browserNotNowLabel, browserNeverLabel}
)

// parseBrowserPromptMenu reads lines (the screen, trailing blank lines removed) as Claude's browser menu, or reports false.
func parseBrowserPromptMenu(lines []string) (promptScreen, bool) {
	last := len(lines) - 1
	for last >= 0 && strings.TrimSpace(lines[last]) == "" {
		last--
	}
	if last < 3 {
		return promptScreen{}, false
	}
	first := last - 2 // the three rows are the last three lines
	titleAt := -1
	for _, l := range lines {
		if strings.TrimSpace(l) == browserPromptTitle {
			if titleAt >= 0 {
				return promptScreen{}, false // two title lines anywhere on the screen: not the one dialog this reads
			}
			titleAt = 0
		}
	}
	titleAt = -1
	for i := first - 1; i >= 0 && i >= first-12; i-- {
		t := strings.TrimSpace(lines[i])
		if separatorRe.MatchString(t) {
			break
		}
		if t == browserPromptTitle {
			if titleAt >= 0 {
				return promptScreen{}, false // two title lines: a spoofed copy above the real dialog
			}
			titleAt = i
		}
	}
	if titleAt < 0 {
		return promptScreen{}, false
	}
	// Between the title and the rows: the dialog's one description paragraph, and nothing that looks like a row.
	var body []string
	for i := titleAt + 1; i < first; i++ {
		if t := strings.TrimSpace(lines[i]); t != "" {
			if markedLineRe.MatchString(lines[i]) {
				return promptScreen{}, false
			}
			body = append(body, t)
		}
	}
	marked := -1
	opts := make([]promptOption, 0, 3)
	for k := 0; k < 3; k++ {
		m := browserRowRe.FindStringSubmatch(lines[first+k])
		if m == nil {
			return promptScreen{}, false
		}
		label := strings.TrimSpace(m[3])
		if !strings.EqualFold(normalizeLabel(label), normalizeLabel(browserLabels[k])) {
			// "Install extension" may run into its description with one space in a log; only an exact label with an optional 2+ space description is accepted
			return promptScreen{}, false
		}
		if m[2] != "" {
			if marked >= 0 {
				return promptScreen{}, false
			}
			marked = k
		}
		if utf8.RuneCountInString(label) > 40 {
			return promptScreen{}, false
		}
		opts = append(opts, promptOption{N: k + 1, Label: browserLabels[k], Selected: k == marked, Action: "select"})
	}
	if marked < 0 {
		return promptScreen{}, false
	}
	for i := range opts {
		opts[i].Selected = i == marked
	}
	question := browserPromptTitle
	if len(body) > 0 {
		question += " " + strings.Join(body, " ")
	}
	return promptScreen{Title: browserPromptTitle, Question: question, Options: opts, Unnumbered: true, BrowserMenu: true, context: strings.Join(body, "\n")}, true
}

// isBrowserPromptMenu says whether s is Claude's browser menu as parseBrowserPromptMenu reads it, and the one choice a row may take is its "Not now".
func isBrowserPromptMenu(s promptScreen) bool {
	return s.BrowserMenu && s.Unnumbered && !s.Multi && len(s.Options) == 3 &&
		normalizeLabel(s.Options[0].Label) == normalizeLabel(browserInstallLabel) &&
		normalizeLabel(s.Options[1].Label) == normalizeLabel(browserNotNowLabel) &&
		normalizeLabel(s.Options[2].Label) == normalizeLabel(browserNeverLabel)
}
