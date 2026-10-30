package ptymanager

import (
	"regexp"
	"strings"
)

// Pi's editor has no prompt marker. It is the lines between two horizontal rules, above a footer of the working folder and a line of context use and model (#11165, the reporter's diagnosis):
//
//	────────────────────────────────────────
//	(what is typed; empty when nothing is)
//	────────────────────────────────────────
//	~/work/project (main)
//	↑29k ↓436 R50k CH0.0% $0.004 (sub) 3.6%/272k (auto)     gpt-6-luna • medium
//
// Until it was read, Coral could not tell a Pi agent's empty editor from a draft in it or from its own text still waiting for an Enter, so a notice whose Enter was lost was not found again and
// the next one was pasted after it: they piled up in the editor.

// piContextUseRe is the footer's last line: context use as "3.6%/272k" ("0.0%/1.0M"), which no other agent's screen has.
var piContextUseRe = regexp.MustCompile(`\d+(\.\d+)?%/\d+(\.\d+)?[kKMm]\b`)

// piFooterLines is how many lines the footer may have between the editor's lower rule and the context line (the folder; an extension's status line).
const piFooterLines = 3

// isRule: a line of one horizontal rule and nothing else.
func isRule(line string) bool {
	t := strings.TrimSpace(line)
	return len([]rune(t)) >= 8 && strings.Trim(t, "─") == ""
}

// piEditorText is what Pi's editor holds, read from the screen, or ok=false when no Pi editor is on it.
func piEditorText(screen string) (text string, ok bool) {
	lines := tailLines(screenText(screen), boxScanLines)
	ctxLine := -1
	for i := len(lines) - 1; i >= 0 && i >= len(lines)-2-piFooterLines; i-- {
		if piContextUseRe.MatchString(lines[i]) {
			ctxLine = i
			break
		}
	}
	if ctxLine < 0 {
		return "", false
	}
	lower := -1
	for i := ctxLine - 1; i >= 0 && i >= ctxLine-1-piFooterLines; i-- {
		if isRule(lines[i]) {
			lower = i
			break
		}
	}
	if lower < 0 {
		return "", false
	}
	upper := -1
	for i := lower - 1; i >= 0; i-- {
		if isRule(lines[i]) {
			upper = i
			break
		}
	}
	if upper < 0 {
		return "", false
	}
	var parts []string
	for _, l := range lines[upper+1 : lower] {
		if t := strings.TrimSpace(l); t != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, " "), true
}
