package ptymanager

import (
	"context"
	"regexp"
	"strings"
)

// What stops an auto-sleep on the agent's screen (#12111, Security): killing the terminal loses what is in it.
const (
	SleepStopDialog     = "a prompt or menu is open"                            // answering it is a person's; sleeping would hide it
	SleepStopBackground = "a background shell or monitor is still running"      // the footer says so: sleeping would kill it
	SleepStopDraft      = "a draft in the box, or a screen that cannot be read" // a person's typed text is lost with the terminal; an unreadable screen counts as a draft
)

// ScreenStopsSleep reads the agent's screen once, as a delivery does (the same look: DeliverAutomated's), and says why it must not be put to sleep, or "" when the screen is an
// empty input box. ownWait is that the agent has a board wait registered: its own `coral-board wait`, run in the background, is the one shell or monitor the footer names (v2.0.34's real teams: every
// parked worker read background_running, #12335), so exactly one is not a reason to stay awake; two or more, or a footer that says "still running" with no count, are. A terminal with no screen to read, a screen that cannot be read or is blank, and the leftover of Coral's own text all count as a draft: nothing is known to be safe to lose.
func ScreenStopsSleep(ctx context.Context, term any, name, agentType, sessionID string, ownWait bool) string {
	if _, ok := term.(ScreenReader); !ok {
		return SleepStopDraft
	}
	if r, ok := term.(ScreenReader); ok {
		if screen, err := r.AgentScreen(ctx, name, agentType, sessionID); err == nil && BackgroundMarker(screen) != "" && !(ownWait && onlyOneBackground(screen)) {
			return SleepStopBackground
		}
	}
	v := AutomatedInput{Term: term, Name: name, AgentType: agentType, SessionID: sessionID}.look(ctx)
	switch {
	case v.skip == SkipPrompt:
		return SleepStopDialog
	case v.skip != "" || v.leftover:
		return SleepStopDraft
	}
	return ""
}

// The footer of a CLI with something running in the background after its turn ended: "· done 5:38 PM · 1 shell still running" above the box and "· 1 shell ·" in the status line under it (#12111).
// Only those lines count (#12335): the pane read has 40 lines of history, and a count or "still running" in an earlier turn's line or in the agent's own words is not a thing running now (v2.0.34:
// parked workers whose screen showed no marker read background_running). A footer line is one of footerOf's: with a box to anchor on the words alone count (a separator that changed must not hide a job), without one they need the middle dot.
const footerLines = 15

var (
	backgroundWords   = `(?:\bstill running\b|\b\d+ (?:shells?|monitors?|background (?:tasks?|commands?))\b)`
	backgroundRunning = regexp.MustCompile(`(?i)[^\n]*?` + backgroundWords)  // in the footer zone anchored on the box: the words alone (a separator that changed must not hide a job)
	backgroundDotted  = regexp.MustCompile(`(?i)·[^\n]*?` + backgroundWords) // on a screen with no box to anchor on: the words after the footer's middle dot
	backgroundCount   = regexp.MustCompile(`(?i)\b(\d+) (shell|monitor|background task|background command)s?\b`)
)

// footerOf is the footer of the screen, anchored on the input box (Security, #12335): the one non-blank line above the box's top border (where "· done 5:38 PM · 1 shell still running" is) and every
// non-blank line from the box's bottom border down (the status line, however many notices follow it), so a taller footer still counts and the history above never does. A border is a line that
// starts with two box-drawing dashes; it can carry the status in it ("──[]── manual mode on · ? for shortcuts ──"). Without two borders on the screen, the last footerLines non-blank lines.
func footerOf(screen string) (lines []string, anchored bool) {
	all := strings.Split(screen, "\n")
	rules := []int{}
	for i, l := range all {
		if strings.HasPrefix(strings.TrimSpace(l), "──") {
			rules = append(rules, i)
		}
	}
	nonBlank := func(from, to int) []string {
		var out []string
		for _, l := range all[from:to] {
			if strings.TrimSpace(l) != "" {
				out = append(out, l)
			}
		}
		return out
	}
	if len(rules) < 2 {
		lines = nonBlank(0, len(all))
		if len(lines) > footerLines {
			lines = lines[len(lines)-footerLines:]
		}
		return lines, false
	}
	bottom, top := rules[len(rules)-1], rules[len(rules)-2]
	var above []string
	for k := top - 1; k >= 0; k-- { // the first non-blank line above the box
		if strings.TrimSpace(all[k]) != "" {
			above = []string{all[k]}
			break
		}
	}
	return append(above, nonBlank(bottom, len(all))...), true
}

// BackgroundMarker is the footer text that says something runs in the background (cut at 60 characters), "" when none does. It is a counter's worth of the screen, for the log.
func BackgroundMarker(screen string) string {
	lines, anchored := footerOf(screen)
	re := backgroundDotted
	if anchored {
		re = backgroundRunning
	}
	for _, l := range lines {
		if m := re.FindString(l); m != "" {
			if r := []rune(m); len(r) > 60 { // on a rune boundary: the line begins with a two-byte dot
				m = string(r[:60])
			}
			return strings.TrimSpace(m)
		}
	}
	return ""
}

// onlyOneBackground: the footer names exactly one background item, however many times it says so ("· 1 shell still running" and "· 1 shell ·" are the same one). A footer with no count, or any count
// above one, is not it.
func onlyOneBackground(screen string) bool {
	kinds := map[string]bool{} // a shell and a monitor are two items, whatever number each says
	lines, anchored := footerOf(screen)
	for _, l := range lines {
		if !anchored && !strings.Contains(l, "·") {
			continue
		}
		for _, c := range backgroundCount.FindAllStringSubmatch(l, -1) {
			if c[1] != "1" {
				return false
			}
			kinds[strings.ToLower(c[2])] = true
		}
	}
	return len(kinds) == 1
}

// PanePIDer is implemented by the session terminals that can name the process an agent's terminal started, the root of its process tree (#12111): auto-sleep reads the tree's use of
// the CPU from it and treats a terminal that cannot as one it may not put to sleep.
type PanePIDer interface {
	PanePID(ctx context.Context, name, agentType, sessionID string) (int, error)
}
