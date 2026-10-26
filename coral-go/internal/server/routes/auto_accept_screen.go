package routes

import (
	"strings"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// screenAction reads the tool and its input from the prompt on screen. Lines
// a long command or path wrapped over are joined with \x00: a command is tried
// with a space and with nothing in between, a path with nothing.
func screenAction(agentType string, d approvalDecision, capture string) (string, string) {
	switch agentType {
	case at.Codex:
		var parts []string
		dest := false
		headers := 0
		inCommand := false // the "$ " line has started: from there every line is the command's own text, whatever it looks like
		for _, l := range d.Context {
			if codexApprovalHeaderRe.MatchString(l) {
				headers++
				continue
			}
			if ruleLineRe.MatchString(l) { // box-drawing lines inside the span are not text
				continue
			}
			if !inCommand {
				switch {
				case strings.HasPrefix(l, "Environment:"), strings.HasPrefix(l, "Reason:"), strings.HasPrefix(l, "Description:"):
					continue
				case strings.HasPrefix(l, "Destination:"):
					dest = true
					if rest := strings.TrimSpace(strings.TrimPrefix(l, "Destination:")); rest != "" {
						parts = append(parts, rest)
					}
					continue
				}
				if strings.HasPrefix(l, "$ ") {
					inCommand = true
				}
			}
			parts = append(parts, strings.TrimPrefix(l, "$ "))
		}
		if headers > 1 {
			return "ambiguous", "" // two approval headers in one prompt: what it asks about is unclear
		}
		if d.Kind == "edit" || dest {
			return "edit", strings.Join(parts, "\x00")
		}
		return "command", strings.Join(parts, "\x00")

	case at.Agy, at.Antigravity, at.Gemini:
		var parts []string
		inCmd := false
		headers, questions := 0, 0
		for _, l := range d.Context {
			if agyApprovalHeaderRe.MatchString(l) {
				headers++
				if headers > 1 {
					return "ambiguous", "" // two approval headers in one prompt: what it asks about is unclear
				}
				inCmd = true
				continue
			}
			if ruleLineRe.MatchString(l) { // box-drawing lines inside the span are not text
				continue
			}
			if agyApprovalQuestionRe.MatchString(l) {
				questions++
				if questions > 1 {
					return "ambiguous", "" // two question lines: the command's own text printed one, and what it asks about is unclear (#7222)
				}
				continue
			}
			if inCmd && questions == 0 {
				parts = append(parts, strings.TrimSpace(l))
			}
		}
		// The real question is the line just above the menu: with a header and no question there, or a question line that is not the last (the command's own text printed it), what the prompt asks about is
		// unclear (#7234).
		if headers == 1 {
			last := ""
			for k := len(d.Context) - 1; k >= 0; k-- {
				if !ruleLineRe.MatchString(d.Context[k]) {
					last = d.Context[k]
					break
				}
			}
			if !agyApprovalQuestionRe.MatchString(last) {
				return "ambiguous", ""
			}
		}
		return "command", strings.Join(parts, "\x00")
	}
	// Claude: the newest tool line above the prompt. A long call wraps over several screen
	// lines, so the newest line that STARTS a call is taken and its continuation lines are
	// joined (with \x00) up to the closing parenthesis. Matching only complete one-line calls
	// fell through a wrapped one to an older call in the scrollback (QA #3207).
	lines := strings.Split(capture, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		m := claudeToolStartRe.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		parts := []string{strings.TrimRight(m[2], " ")}
		for j := i + 1; !strings.HasSuffix(parts[len(parts)-1], ")") && j < len(lines); j++ {
			next := strings.TrimSpace(lines[j])
			if next == "" || ruleLineRe.MatchString(lines[j]) || strings.HasPrefix(next, "⎿") || strings.HasPrefix(next, "⏺") {
				break
			}
			parts = append(parts, next)
		}
		last := len(parts) - 1
		parts[last] = strings.TrimSuffix(parts[last], ")")
		return m[1], strings.Join(parts, "\x00")
	}
	return "", ""
}
