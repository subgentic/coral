package routes

import (
	"context"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/permreview"
)

// Hermes's two prompts (#12170, goal #192): a dangerous-command approval and a clarify question. Hermes draws each in a box (a rounded border and "│ row │" lines) over its input row, with a footer line under it
// ("↑/↓ to select, Enter to confirm (292s)"). The options are numbered with the pointer on the selected one, and a digit answers at once, with no Enter (checked on Hermes v0.22.5, the tester's captures in
// testdata/hermes_*.txt). Read from the screen like Codex's: nothing of the request is taken from a hook (the hook is an allow-list that never reads a command).
//
//	╭────────────────────╮                    ╭─ Hermes Agent needs your input ─╮
//	│ ⚠️   Dangerous Command │                    │ 1 question                      │
//	│ rm -rf /tmp/x      │                    │ ▸ Which colour?                 │
//	│ ❯ 1. Allow once    │                    │   ❯ 1. blue (Recommended)       │
//	│   4. Deny          │                    │     4. Other (type your answer) │
//	│ recursive delete   │                    ╰─────────────────────────────────╯
//	╰────────────────────╯

// The kinds of prompt a screen shows (promptScreen.Kind).
const (
	promptKindApproval = "approval"
	promptKindQuestion = "question"
)

var (
	hermesBoxTopRe    = regexp.MustCompile(`^\s*╭`)
	hermesBoxBottomRe = regexp.MustCompile(`^\s*╰[─]*╯\s*$`)
	hermesRowRe       = regexp.MustCompile(`^\s*│ ?(.*?)\s*│\s*$`)
	hermesFooterRe    = regexp.MustCompile(`^\s*(↑/↓ to select|type your answer and press Enter)`)
	hermesOptionRe    = regexp.MustCompile(`^\s*([❯>]\s*)?(\d{1,2})\.\s+(.+?)\s*$`)
	hermesQuestionRe  = regexp.MustCompile(`^\s*▸\s*(.+?)\s*$`)
	hermesCountRe     = regexp.MustCompile(`^\d+ questions?$`)
)

// parseHermesPrompt reads a Hermes approval or clarify box from the bottom of a capture. Not ok for anything else, and for a clarify with no options (the person types the answer in the terminal).
func parseHermesPrompt(capture string) (promptScreen, bool) {
	lines := strings.Split(strings.ReplaceAll(capture, "\r", ""), "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	// The box ends within a few lines of the bottom: the footer, Hermes's status line and its input row follow it.
	bottom := -1
	for i := len(lines) - 1; i >= 0 && i >= len(lines)-8; i-- {
		if hermesBoxBottomRe.MatchString(lines[i]) {
			bottom = i
			break
		}
	}
	if bottom < 0 {
		return promptScreen{}, false
	}
	foot := bottom + 1
	for foot < len(lines) && foot <= bottom+3 && strings.TrimSpace(lines[foot]) == "" { // a capture can leave blank lines between the box and its footer
		foot++
	}
	if foot >= len(lines) || !hermesFooterRe.MatchString(lines[foot]) {
		return promptScreen{}, false
	}
	top := -1
	for i := bottom - 1; i >= 0 && i >= bottom-30; i-- {
		if hermesBoxTopRe.MatchString(lines[i]) {
			top = i
			break
		}
	}
	if top < 0 {
		return promptScreen{}, false
	}
	width := utf8.RuneCountInString(strings.TrimSpace(lines[top])) - 4 // the text a row holds: the border and a space on each side
	var rows []string
	for _, l := range lines[top+1 : bottom] {
		m := hermesRowRe.FindStringSubmatch(l)
		if m == nil {
			return promptScreen{}, false // a line that is not a row of the box: not the box this reads
		}
		rows = append(rows, m[1])
	}
	switch {
	case strings.Contains(lines[top], "Hermes Agent needs your input"):
		return hermesClarify(rows)
	case len(rows) > 0 && strings.Contains(rows[0], "Dangerous Command"):
		return hermesApproval(rows, width)
	}
	return promptScreen{}, false
}

// hermesOptions are the numbered rows, with the pointer; a row that is not one is skipped.
func hermesOptions(rows []string) (opts []promptOption, last int) {
	last = -1
	for i, r := range rows {
		if m := hermesOptionRe.FindStringSubmatch(r); m != nil {
			n := 0
			for _, c := range m[2] {
				n = n*10 + int(c-'0')
			}
			opts = append(opts, promptOption{N: n, Label: m[3], Selected: m[1] != "", Action: "select"})
			last = i
		}
	}
	return opts, last
}

func hermesApproval(rows []string, width int) (promptScreen, bool) {
	// The command: the rows after the heading up to the first blank one. A row that fills the box is a command cut at the box's edge (inside a word, where Hermes has no space to break at): the next row continues it
	// with nothing between; a shorter one ended at a space, which the wrap took.
	var cmd strings.Builder
	prevFull := false
	i := 1
	for ; i < len(rows) && strings.TrimSpace(rows[i]) == ""; i++ { // the blank row under the heading
	}
	for ; i < len(rows) && strings.TrimSpace(rows[i]) != ""; i++ {
		if cmd.Len() > 0 && !prevFull {
			cmd.WriteByte(' ')
		}
		cmd.WriteString(strings.TrimSpace(rows[i]))
		prevFull = width > 0 && utf8.RuneCountInString(strings.TrimRight(rows[i], " ")) >= width
	}
	opts, last := hermesOptions(rows[i:])
	var kept []promptOption
	for _, o := range opts {
		switch {
		case strings.EqualFold(o.Label, "Show full command"):
			continue // it only draws the command in full: not an answer
		case strings.EqualFold(o.Label, "Allow once"):
			o.Kind = "allow_once"
		case strings.HasPrefix(strings.ToLower(o.Label), "allow"), strings.HasPrefix(strings.ToLower(o.Label), "add to"):
			o.Kind = "allow_always" // for this session, or for good: they last past this one answer
		case isRejectLabel(o.Label):
			o.Kind = "reject"
		}
		kept = append(kept, o)
	}
	reason := ""
	for _, r := range rows[i+last+1:] {
		if t := strings.TrimSpace(r); t != "" {
			reason = t
			break
		}
	}
	if len(kept) < 2 || cmd.Len() == 0 {
		return promptScreen{}, false
	}
	title := "Dangerous command"
	if reason != "" {
		title += ": " + reason
	}
	return promptScreen{Title: title, Question: "Allow this command to run?", Options: kept, context: cmd.String(), Kind: promptKindApproval}, true
}

func hermesClarify(rows []string) (promptScreen, bool) {
	question := ""
	for _, r := range rows {
		if m := hermesQuestionRe.FindStringSubmatch(r); m != nil && question == "" {
			question = m[1]
		}
	}
	opts, _ := hermesOptions(rows)
	var kept []promptOption
	for _, o := range opts {
		if strings.HasPrefix(strings.ToLower(o.Label), "other (type") {
			continue // the free-text row: the answer is typed in the terminal
		}
		kept = append(kept, o)
	}
	if question == "" || len(kept) < 2 {
		return promptScreen{}, false
	}
	return promptScreen{Question: question, Options: kept, Kind: promptKindQuestion}, true
}

// hermesRequestFromScreen gives Hermes's open request what its screen shows. The hook says only that something waits ("Wants to use approval": it never reads the request); the box says which it is. A clarify is a
// question, so the agent counts under Question, not Permission; a dangerous command's own words are its Wants. The text is display only and goes through the same cleaning as any screen text.
func hermesRequestFromScreen(ev *StateEvent, screen string) {
	s, ok := parseHermesPrompt(screen)
	if !ok {
		if q, isClarify := hermesClarifyQuestion(screen); isClarify { // a clarify with no options to choose from: still a question
			ev.Kind, ev.Summary, ev.Wants = promptKindQuestion, "Wants to know: "+q, "Wants to know: "+q
		}
		return
	}
	switch s.Kind {
	case promptKindQuestion:
		q := "Wants to know: " + clitext.CleanName(s.Question)
		ev.Kind, ev.Summary, ev.Wants = promptKindQuestion, q, q
	case promptKindApproval:
		ev.Wants = "Wants to run: " + cutRunes(clitext.CleanName(s.context), 200)
	}
}

// hermesClarifyQuestion is the question of a clarify box that has no numbered options (the answer is typed).
func hermesClarifyQuestion(screen string) (string, bool) {
	lines := strings.Split(strings.ReplaceAll(screen, "\r", ""), "\n")
	for i := len(lines) - 1; i >= 0 && i >= len(lines)-14; i-- {
		if strings.Contains(lines[i], "Hermes Agent needs your input") && hermesBoxTopRe.MatchString(lines[i]) {
			for _, l := range lines[i+1:] {
				if m := hermesRowRe.FindStringSubmatch(l); m != nil {
					if q := hermesQuestionRe.FindStringSubmatch(m[1]); q != nil {
						return clitext.CleanName(q[1]), true
					}
					continue
				}
				break
			}
		}
	}
	return "", false
}

func cutRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// hermesCommandOf is the command of the newest tool call that has one in a Hermes chat's rows (oldest first), "" when none: the command as Hermes stored it, which the screen cannot show (the terminal drops a zero-width
// character, so a command that hides what it does reads as a plain one there).
func hermesCommandOf(rows []map[string]any) string {
	for i := len(rows) - 1; i >= 0; i-- {
		uses, _ := rows[i]["tool_uses"].([]map[string]any)
		for j := len(uses) - 1; j >= 0; j-- {
			if cmd, _ := uses[j]["command"].(string); strings.TrimSpace(cmd) != "" {
				return cmd
			}
		}
	}
	return ""
}

// foldCommand is s without its white space and its invisible and format characters, so a command and the same command as a terminal draws it compare equal.
func foldCommand(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || unicode.Is(unicode.Cf, r) || unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

// applyHermesCommand judges a Hermes approval by the command Hermes itself holds (the tool call in its state.db, as the chat shows it) when that is the command on the screen: the screen is the box's text, which drops what
// the terminal does not draw, so an invisible, format or reordering character is in the stored command and not on the screen. The same rule as every CLI then applies (permreview): such a command offers Reject only and
// the note names the character. A stored command that is not the screen's (another call, nothing stored) changes nothing: the screen's own text stands.
func applyHermesCommand(s *promptScreen, stored string) {
	if s.Kind != promptKindApproval || stored == "" || foldCommand(stored) != foldCommand(s.context) {
		return
	}
	rv := permreview.Of(stored)
	s.context = stored
	s.Target = rv.Shown
	if !rv.Allowed() {
		s.OnlyReject, s.Note = true, rv.Note()
	}
	s.AskID = askID(*s)
}

// hermesStoredCommand reads the command of the agent's newest tool call from its Hermes session (few rows: the call is the last thing it did).
func (h *SessionsHandler) hermesStoredCommand(ctx context.Context, sessionID string) string {
	if sessionID == "" {
		return ""
	}
	return hermesCommandOf(h.hermesTranscriptRows(ctx, sessionID, 12).Window)
}
