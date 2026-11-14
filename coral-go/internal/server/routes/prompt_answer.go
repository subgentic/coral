package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/subgentic/coral/internal/board"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/permreview"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/terminalinput"
	"github.com/subgentic/coral/internal/tracking"
)

// Answering an agent's prompt from the chat.
//
// Claude Code's permission prompts, AskUserQuestion dialogs and plan
// approvals draw a numbered option list at the bottom of the terminal, with
// "❯" marking the selected option; pressing an option's digit answers it.
// Codex draws its sign-in menu and approval prompts the same way, marking
// the selected option with ">" (or "›"), and takes the same digits
// (a multi-question dialog advances to the next question, then to a
// "Submit answers" review). The option list varies (permission choices
// depend on the tool and mode), so it is read from the screen rather than
// assumed, and an answer is only sent after re-reading the screen and
// confirming the digit still maps to the option the user clicked.

// How an option is answered:
//   - "select": its digit answers it
//   - "text":   its digit opens a text field ("Type something.", "Tell Claude
//     what to change"); the answer is typed, then Enter
//   - "chat":   its digit closes the dialog so the user can reply in chat
//     ("Chat about this")
type promptOption struct {
	N        int    `json:"n"`
	Label    string `json:"label"`
	Selected bool   `json:"selected"`
	Action   string `json:"action"`
	// Kind is what the option does where something other than its words says so: "allow_once" (the approval table's approve-once option, or an opencode card's Allow once), "allow_always" and "reject" (an
	// opencode card's own answers). Empty where nothing but the label is known (a screen's other options): optionIsReject then falls back to the label (#11407).
	Kind    string `json:"kind,omitempty"`
	Wrapped bool   `json:"wrapped,omitempty"`
	// Checked: the box of a multi-select option ("[✔]"); the label is what follows the box (#5232).
	Checked bool `json:"checked,omitempty"`
}

// The Submit row under the options of a multi-select question (#5232): not numbered, reached with Down from
// the last option and taken with Enter; "Next" when more questions follow.
type promptSubmit struct {
	Label   string `json:"label"`
	Focused bool   `json:"focused"`
}

// One line of the "Review your answers" step of a multi-question dialog.
type promptReviewItem struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

type promptScreen struct {
	// Title: the dialog's heading, when its top line is one ("Hooks need review" over "2 hooks are new or changed ...", #306).
	// Question still begins with it; the card shows the title as a heading and the rest of Question under it.
	Title    string `json:"title,omitempty"`
	Question string `json:"question"`
	// Kind: what the prompt is where the screen says (Hermes: "approval" of a command, "question" of its own), so the card is a question and not a permission for a question (#12170).
	Kind    string             `json:"kind,omitempty"`
	Options []promptOption     `json:"options"`
	Review  []promptReviewItem `json:"review,omitempty"`
	// Unnumbered: the options carry no numbers (Claude Code's folder-trust and API-key menus at launch,
	// #4543); n is an option's place in the list, and it is answered with the arrow keys and Enter.
	Unnumbered bool `json:"unnumbered,omitempty"`
	// TrustFolder and TrustOffer: Claude's folder-trust menu names its folder (read from the screen, never from the agent's words) and a row may offer Yes for it
	// only to the person's own dashboard and for a folder Coral may trust (#14110, prompt_trust.go).
	TrustFolder string `json:"trust_folder,omitempty"`
	TrustOffer  bool   `json:"trust_offer,omitempty"`
	// TrustWhy: the plain reason there is no Yes on the folder-trust menu when none is offered (#14572); "" when the offer is made or the menu is another.
	TrustWhy string `json:"trust_why,omitempty"`
	// RateLimit: Codex's 'Approaching rate limits' notice may be answered whole from a row, to the person's own dashboard only (#14774): the model it offers. Absent for everyone else and for any other menu.
	RateLimit      *rateLimitOffer `json:"rate_limit_offer,omitempty"`
	rateLimitModel string          // the model the screen's structure names when it is exactly that notice (markRateLimit); the offer is decided per caller
	// TrustCut: the folder path ran past the lines Coral joins, so TrustFolder is only its start (#14586); never sent.
	TrustCut bool `json:"-"`
	// BrowserMenu: Claude's "Claude wants to use your browser" menu, read by structure (prompt_browser.go, #14151): a row may take its "Not now" only.
	BrowserMenu bool `json:"browser_menu,omitempty"`
	// Multi: every option has a box (a multi-select question, #5232): a digit toggles the box and nothing is
	// answered until Submit is taken. Submit is the row under the options (nil when it is not on screen).
	Multi  bool          `json:"multi,omitempty"`
	Submit *promptSubmit `json:"submit,omitempty"`
	// The few lines above the question (a permission prompt's command): with the question and the labels,
	// what tells this prompt from the next one the agent opens (samePrompt).
	context string
	// command: the whole request a permission prompt draws between its two dashed rules (a long command, an edit's diff), read from the screen up to commandMaxLines (#14173); "" when the screen draws no such block.
	command string
	// commandOpenMissing: the dashed rule that closes the request is just above the question but the one that opens it was not found within commandMaxLines: the request cannot be shown whole, so only Reject is offered (#14173, Security).
	commandOpenMissing bool
	// TargetNote: Claude's own line under the request ("Contains brace with quote character", "This command requires approval"), plain text, shown beneath the command (#14173).
	TargetNote string `json:"target_note,omitempty"`
	// Target is the lines above the question (a permission prompt's command) as permreview shows them: whole up to its limit, hidden characters written out. OnlyReject and Note: the request holds a character
	// that hides what it does, or is longer than a card shows, so only Reject is offered and an Allow answer is refused (#11399). A cut the CLI itself makes on its screen cannot be known.
	Target     string `json:"target,omitempty"`
	OnlyReject bool   `json:"only_reject,omitempty"`
	Note       string `json:"note,omitempty"`
	// Unreadable: Coral did not read the request in full (longer than a card shows, its opening rule not on the screen, or cut by the CLI on its screen). It implies OnlyReject for the server, which still refuses a Yes,
	// but a card draws no answer at all for it, not even No: it says so and sends the person to the agent's terminal (#15501). A request that holds a hidden character but was read whole is only OnlyReject: No stays (#15140).
	Unreadable bool `json:"unreadable,omitempty"`
	// AutoBlockAt: when Claude Code's own timer on this dialog ends and it blocks the request by itself (RFC 3339, from the time left on the screen when it was read; "" when the screen shows none). Display only: it is not
	// part of the ask's identity, so it never changes what an answer is checked against (#15140).
	AutoBlockAt string `json:"auto_block_at,omitempty"`
	// AskID names this ask: a short digest of its title, question, the lines above it and its option labels (not the selection). An answer that carries the id it was drawn for is refused
	// when the screen now shows another ask (#10400): a row or card drawn for one command cannot answer the next one.
	AskID string `json:"ask_id,omitempty"`
	// boxes: how many options carry a box (the first ones; a "Chat about this" row has none)
	boxes int
}

// Time for the dialog to turn an option into a text field before typing
var promptTextDelay = 300 * time.Millisecond

// After an answer is sent the screen is read again (#4543): the answer is ok only once the prompt it
// answered has gone (the next question, the review step, or the agent at work), and Codex's menus that only
// move their selection on a digit are confirmed with Enter.
var (
	promptPollEvery = 50 * time.Millisecond
	// How long the same prompt must stay up, with the chosen option selected, before Enter confirms it:
	// a menu that a digit answers redraws within a frame or two, and must not get the Enter as well.
	promptSettle = 250 * time.Millisecond
	// How long an answered prompt has to go.
	promptClearTimeout = 2500 * time.Millisecond
)

var (
	promptOptionRe = regexp.MustCompile(`^\s*([❯›>]\s*)?(\d{1,2})\.\s+(.+?)\s*$`)
	separatorRe    = regexp.MustCompile(`^\s*[─━╌┄═]+\s*$`)
	// A multi-select option's box ("[✔] Label", "[ ] Label"; "[×]" on a terminal without the tick)
	optionBoxRe = regexp.MustCompile(`^\[([ ✔✓√×xX*])\]\s*(.*)$`)
	// The Submit row of a multi-select question, with the pointer when it is the focused row
	submitRowRe = regexp.MustCompile(`^\s*([❯›>]\s*)?(Submit|Next)\s*$`)
)

func optionAction(label string) string {
	lower := strings.ToLower(strings.TrimSpace(label))
	switch {
	case strings.HasPrefix(lower, "type something"),
		strings.HasPrefix(lower, "tell claude what to change"),
		strings.HasPrefix(lower, "tell agent what to change"),
		strings.HasPrefix(lower, "tell antigravity what to change"):
		return "text"
	case strings.HasPrefix(lower, "chat about this"):
		return "chat"
	}
	return "select"
}

func indentOf(s string) int {
	return len(s) - len(strings.TrimLeft(s, " "))
}

// parsePromptScreen reads the option block of an open prompt from the bottom
// of a terminal capture. It walks up from the last option line through the
// options, their wrapped/description lines (indented five or more) and
// separators, and stops at the prompt's own question line. A numbered list
// elsewhere on screen (a plan's steps, a reply) is never reached, and a block
// without a selection marker is not a prompt.
//
// Its text (title, question, option labels, review lines, the Submit label) comes out clean (cleanPromptScreen): what an agent's
// screen can carry is shown on the card, matched by auto-accept and kept in the session state.
func parsePromptScreen(capture string) (promptScreen, bool) {
	return parsePromptScreenFor(at.Claude, capture)
}

// parsePromptScreenFor is parsePromptScreen for a session of agentType: the request block between Claude's two dashed rules is read ONLY for a Claude session (#14173, Security): another agent's program can print
// dashed rules and a question of its own, and that must not become the "request" a person is shown or the part of it that is judged.
func parsePromptScreenFor(agentType, capture string) (promptScreen, bool) {
	s, ok := parsePromptScreenRaw(capture)
	if !ok {
		return s, false
	}
	if agentType != at.Claude {
		s.command, s.TargetNote, s.commandOpenMissing = "", "", false
	} else if left, ok := claudeTimerLeft(capture); ok {
		s.AutoBlockAt = time.Now().Add(left).UTC().Format(time.RFC3339)
	}
	// Judged on the raw text, before cleanPromptScreen drops what hides: the terminal still holds it.
	rv := permreview.Merge(permreview.Of(s.context), permreview.Of(s.command), permreview.Of(s.Question), permreview.Of(s.Title))
	target := dropRuleLines(permreview.Of(s.context).Shown) // the three lines above the question can be Claude's dashed rule: a card never shows rows of dashes as the request (#15140)
	if s.command != "" {
		target = permreview.Of(s.command).Shown // the whole block between the rules, not its last three lines (#14173)
	}
	s = cleanPromptScreen(s)
	s.AskID = askID(s)
	if s.context != "" || s.command != "" {
		s.Target = target
	}
	if !rv.Allowed() {
		s.OnlyReject, s.Note, s.Unreadable = true, rv.Note(), rv.Cut
	} else if s.commandOpenMissing {
		s.OnlyReject, s.Unreadable = true, true
		s.Note = "The top of this request is not on the screen, so Coral could not read it in full. Coral cannot answer it here: answer it in the agent's terminal."
	}
	return s, true
}

// askID is the digest AskID carries.
func askID(s promptScreen) string {
	h := sha256.New()
	for _, part := range []string{s.Title, s.Question, s.context, s.command} {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	for _, o := range s.Options {
		h.Write([]byte(normalizeLabel(o.Label)))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// cleanPromptScreen drops from a parsed prompt's text what can hide or reorder it (Security on #132): controls and escape
// sequences, the bidirectional and other format characters (U+202A-202E, U+2066-2069, U+200B-200F, U+061C, U+FEFF, the soft
// hyphen, ...) and the tag characters, with whitespace folded, through clitext.CleanName, the cleaner names and titles use.
// A screen without them (every one in testdata) is unchanged.
func cleanPromptScreen(s promptScreen) promptScreen {
	s.Title = clitext.CleanName(s.Title)
	s.Question = clitext.CleanName(s.Question)
	s.TargetNote = clitext.CleanName(s.TargetNote)
	opts := make([]promptOption, len(s.Options))
	for i, o := range s.Options {
		o.Label = clitext.CleanName(o.Label)
		opts[i] = o
	}
	s.Options = opts
	if len(s.Review) > 0 {
		review := make([]promptReviewItem, len(s.Review))
		for i, r := range s.Review {
			review[i] = promptReviewItem{Question: clitext.CleanName(r.Question), Answer: clitext.CleanName(r.Answer)}
		}
		s.Review = review
	}
	if s.Submit != nil {
		sub := *s.Submit
		sub.Label = clitext.CleanName(sub.Label)
		s.Submit = &sub
	}
	return s
}

func parsePromptScreenRaw(capture string) (promptScreen, bool) {
	if s, ok := parseHermesPrompt(capture); ok {
		return s, true
	}
	lines := strings.Split(strings.ReplaceAll(capture, "\r", ""), "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	steadyClaudeTimer(lines) // Claude's own countdown line is steady text here (#14581)
	// The option list ends within a few lines of the bottom (a footer such
	// as "Enter to select · Esc to cancel" may follow it).
	end := -1
	for i := len(lines) - 1; i >= 0 && i >= len(lines)-6; i-- {
		if promptOptionRe.MatchString(lines[i]) {
			end = i
			break
		}
	}
	if end < 0 {
		return parseUnnumberedMenu(lines)
	}
	var opts []promptOption
	question, title := "", ""
	questionAt := -1
	sawContinuation := false
	boxes := 0
	firstAt := end
	var submit *promptSubmit
	for j := end + 1; j < len(lines); j++ {
		t := strings.TrimSpace(lines[j])
		if t == "" || separatorRe.MatchString(t) || menuFooterRe.MatchString(t) {
			continue
		}
		if m := submitRowRe.FindStringSubmatch(lines[j]); m != nil && submit == nil {
			submit = &promptSubmit{Label: m[2], Focused: m[1] != ""}
			continue
		}
		sawContinuation = true
		break
	}
	for i := end; i >= 0; i-- {
		line := lines[i]
		// Option 1 is the menu's first: a numbered line above it ("1. first" in a Codex command's own text, #7194) is what the dialog shows, not another option.
		if m := promptOptionRe.FindStringSubmatch(line); m != nil && indentOf(line) < 5 && (len(opts) == 0 || opts[0].N > 1) {
			n, _ := strconv.Atoi(m[2])
			label, checked, boxed := m[3], false, false
			if b := optionBoxRe.FindStringSubmatch(label); b != nil {
				label, checked, boxed = b[2], b[1] != " ", true
			}
			if boxed {
				boxes++
			}
			opts = append([]promptOption{{
				N:        n,
				Label:    label,
				Selected: m[1] != "",
				Action:   optionAction(label),
				Wrapped:  sawContinuation,
				Checked:  checked,
			}}, opts...)
			firstAt = i
			sawContinuation = false
			continue
		}
		if strings.TrimSpace(line) == "" || separatorRe.MatchString(line) {
			continue
		}
		if m := submitRowRe.FindStringSubmatch(line); m != nil && submit == nil && len(opts) > 0 {
			submit = &promptSubmit{Label: m[2], Focused: m[1] != ""} // a row between the options and the ones after it
			continue
		}
		if indentOf(line) >= 5 {
			sawContinuation = true
			continue
		}
		if len(opts) > 0 && opts[0].N > 1 {
			// Option 1 has not been reached yet: intervening lines between options
			// (such as wrapped option lines on narrow terminals) cannot be the question.
			sawContinuation = true
			continue
		}
		// Codex's update menu puts a release-notes link between its
		// "Update available!" heading and the options
		if strings.HasPrefix(strings.TrimSpace(line), "Release notes:") {
			continue
		}
		question = strings.TrimSpace(line)
		questionAt = i
		// A long question wraps onto lines above with the same indent; join
		// them. Header/tab rows, review items, blanks and rules end it, and a
		// different indent (a permission prompt's command above "Do you want
		// to proceed?") is not part of it.
		indent := indentOf(line)
		for j := i - 1; j >= 0 && j >= i-8; j-- {
			prev := lines[j]
			t := strings.TrimSpace(prev)
			if t == "" || separatorRe.MatchString(prev) || indentOf(prev) != indent || promptOptionRe.MatchString(prev) ||
				strings.ContainsAny(t[:min(len(t), 4)], "☐☒←●→│✔❯⎿⏺") || t == "Review your answers" {
				break
			}
			question = t + " " + question
			questionAt = j
		}
		// The dialog's heading ("Hooks need review" over "2 hooks are new or changed. ...", #306), for the card to show on a line
		// of its own: the top line, when it is no wrapped part of the line below it (that line's first word would have fitted on
		// it) and ends no sentence. Question stays the whole text, as auto-accept, samePrompt and the session state read it.
		if questionAt < i {
			top, below := strings.TrimSpace(lines[questionAt]), strings.TrimSpace(lines[questionAt+1])
			if !wrapsInto(top, below) && !strings.ContainsAny(top[len(top)-1:], ".?!:;,") {
				title = top
			}
		}
		break
	}
	if len(opts) < 2 {
		return promptScreen{}, false
	}
	if draftInInputBox(lines, firstAt, end) {
		return promptScreen{}, false
	}
	selected := false
	for i, o := range opts {
		if o.N != i+1 {
			return promptScreen{}, false // not a clean 1..k list
		}
		selected = selected || o.Selected
	}
	multi := boxes >= 2
	if !multi {
		submit = nil // a Submit row is only read under boxed options: "Next" or "Submit" alone is not a row of its own elsewhere
	}
	if !selected && !(submit != nil && submit.Focused) {
		return promptScreen{}, false
	}
	if multi {
		// A digit toggles an option's box, "Type something" included: nothing here is typed (the field is the terminal's)
		for i := range opts {
			if i < boxes && opts[i].Action == "text" {
				opts[i].Action = "select"
			}
		}
	}
	return promptScreen{Title: title, Question: question, Options: opts, Review: parseReview(lines, questionAt), Multi: multi, Submit: submit, boxes: boxes, context: promptContext(lines, questionAt)}.withCommand(lines, questionAt), true
}

var (
	// What an agent draws under its input box, never under a menu that replaces it: Claude's hint and mode line, Codex's status line
	composerFooterRe = regexp.MustCompile(`(?i)\? for shortcuts|\bcontext left\b|shift\+tab to cycle|bypass permissions on|accept edits on`)
	// A rule as wide as an input box's border (a menu's own separators are short or sit between its options)
	boxRuleRe = regexp.MustCompile(`^\s*[─━]{20,}\s*$`)
)

// draftInInputBox reports whether the numbered lines first..last are what a person typed into the agent's input box (a draft that is itself
// a numbered list, "❯ 1. buy milk"), not a menu: the box sits between two full-width rules with no question between them and the options
// (Claude Code), or the agent's footer is under it and no menu footer is (Codex). Answering that would type a digit into the draft, or an
// Enter that sends it (#5254).
func draftInInputBox(lines []string, first, last int) bool {
	above := first - 1
	for above >= 0 && strings.TrimSpace(lines[above]) == "" {
		above--
	}
	below := last + 1
	for below < len(lines) && strings.TrimSpace(lines[below]) == "" {
		below++
	}
	if above >= 0 && below < len(lines) && boxRuleRe.MatchString(lines[above]) && boxRuleRe.MatchString(lines[below]) {
		return true
	}
	footer, menu := false, false
	for _, l := range lines[last+1:] {
		footer = footer || composerFooterRe.MatchString(l)
		menu = menu || menuFooterRe.MatchString(l)
	}
	return footer && !menu
}

var (
	// A menu's footer: Claude Code's "Enter to confirm · Esc to cancel", Antigravity's "↑/↓ Navigate · enter
	// Confirm" (#4577)
	menuFooterRe = regexp.MustCompile(`(?i)\benter to (confirm|select|continue)\b|\besc to cancel\b|↑/↓ navigate|\benter (confirm|select)\b`)
	// The selected option of an unnumbered menu: its marker, then its label
	markedLineRe = regexp.MustCompile(`^(\s*)[❯›>]\s+(\S.*?)\s*$`)
)

// parseUnnumberedMenu reads a menu whose options carry no numbers from the bottom of a capture (lines, with
// trailing blank lines removed): a menu footer within the last three lines, and just above it one block of
// lines that are all options, one of them marked and the others aligned with its label. Its question is the
// nearest paragraph above with a "?" in it (Claude's trust menu has its "Security guide" link in between),
// else the nearest paragraph.
func parseUnnumberedMenu(lines []string) (promptScreen, bool) {
	footer := -1
	for i, seen := len(lines)-1, 0; i >= 0 && seen < 3; i-- {
		t := strings.TrimSpace(lines[i])
		if t == "" {
			continue
		}
		seen++
		if menuFooterRe.MatchString(t) {
			footer = i
			break
		}
	}
	if footer < 0 {
		return promptScreen{}, false
	}
	last := footer - 1
	for last >= 0 && strings.TrimSpace(lines[last]) == "" {
		last--
	}
	first := last
	for first > 0 && strings.TrimSpace(lines[first-1]) != "" {
		first--
	}
	if last < 0 || last-first < 1 {
		return promptScreen{}, false
	}
	marked, col := -1, -1
	for i := first; i <= last; i++ {
		if m := markedLineRe.FindStringSubmatchIndex(lines[i]); m != nil {
			if marked >= 0 {
				return promptScreen{}, false
			}
			marked, col = i, utf8.RuneCountInString(lines[i][:m[4]])
		}
	}
	if marked < 0 {
		return promptScreen{}, false
	}
	var opts []promptOption
	for i := first; i <= last; i++ {
		line := lines[i]
		label := strings.TrimSpace(line)
		if i == marked {
			label = markedLineRe.FindStringSubmatch(line)[2]
		} else if utf8.RuneCountInString(line)-utf8.RuneCountInString(strings.TrimLeft(line, " ")) != col || promptOptionRe.MatchString(line) {
			return promptScreen{}, false // not aligned with the marked option: not a list of options
		}
		label = strings.TrimSpace(strings.TrimPrefix(label, "✔")) // the current choice's check mark
		opts = append(opts, promptOption{N: len(opts) + 1, Label: label, Selected: i == marked, Action: "select"})
	}
	question, questionAt := "", -1
	for i := first - 1; i >= 0 && i >= first-16 && !separatorRe.MatchString(lines[i]); i-- {
		if strings.Contains(lines[i], "?") {
			question, questionAt = paragraphAt(lines, i)
			break
		}
	}
	if questionAt < 0 {
		for i := first - 1; i >= 0 && !separatorRe.MatchString(lines[i]); i-- {
			if strings.TrimSpace(lines[i]) != "" {
				question, questionAt = paragraphAt(lines, i)
				break
			}
		}
	}
	if questionAt < 0 {
		questionAt = first
	}
	return promptScreen{Question: question, Options: opts, Unnumbered: true, context: promptContext(lines, questionAt)}.withCommand(lines, questionAt), true
}

// paragraphAt is the paragraph (non-blank lines between blank lines and rules) holding lines[i], joined, and
// the index of its first line.
func paragraphAt(lines []string, i int) (string, int) {
	in := func(j int) bool {
		return j >= 0 && j < len(lines) && strings.TrimSpace(lines[j]) != "" && !separatorRe.MatchString(lines[j])
	}
	start, end := i, i
	for in(start - 1) {
		start--
	}
	for in(end + 1) {
		end++
	}
	var parts []string
	for _, l := range lines[start : end+1] {
		parts = append(parts, strings.TrimSpace(l))
	}
	return strings.Join(parts, " "), start
}

// promptContext is up to three non-blank lines above the question, trimmed.
func promptContext(lines []string, questionAt int) string {
	var above []string
	for i := questionAt - 1; i >= 0 && len(above) < 3; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			above = append([]string{t}, above...)
		}
	}
	return strings.Join(above, "\n")
}

// commandMaxLines bounds the walk up from the question for a permission prompt's command block.
const commandMaxLines = 400

// claudeTimerRe is Claude Code's own auto-block timer line in its permission dialog ("⚠ Claude Code will automatically block this request in 1:19, to avoid holding up an unattended session"). It counts down on the
// terminal; read as part of the request it froze on the card at the second it was read and made the ask's identity (AskID) change every second, so the person's own answer was refused as 'another ask is open' (#14581, Beta
// run 3). Here the time is replaced by fixed words, in the one place every reader of a screen goes through (the card, the row, the answer, auto-accept); the terminal still shows the real countdown. It is Claude's WHOLE line, and
// is looked for only BELOW the last dashed rule (Claude's own lines under the request, then the question): the command block above it is never touched, so a command that contains the phrase is shown as it is (Security's SHOULD).
var claudeTimerRe = regexp.MustCompile(`^(\s*[⚠│|]?\s*Claude Code will automatically block this request )in \d{1,2}:\d{2}(, to avoid holding up an unattended session\s*)$`)

var claudeTimeLeftRe = regexp.MustCompile(`Claude Code will automatically block this request in (\d{1,2}):(\d{2})\b`)

// claudeTimerLeft is the time Claude Code's own auto-block timer showed when the screen was read (ok false when the screen shows none): from its line below the last dashed rule, like steadyClaudeTimer.
func claudeTimerLeft(capture string) (time.Duration, bool) {
	lines := strings.Split(strings.ReplaceAll(capture, "\r", ""), "\n")
	for i := len(lines) - 1; i >= 0 && i >= len(lines)-40; i-- {
		if dashedRuleRe.MatchString(lines[i]) {
			return 0, false // the rule comes before the timer line: nothing below it
		}
		if m := claudeTimeLeftRe.FindStringSubmatch(lines[i]); m != nil && claudeTimerRe.MatchString(lines[i]) {
			mins, _ := strconv.Atoi(m[1])
			secs, _ := strconv.Atoi(m[2])
			return time.Duration(mins*60+secs) * time.Second, true
		}
	}
	return 0, false
}

// dropRuleLines is text without its lines of only rule characters (Claude's dashed and solid rules): they are the dialog's frame, not what it asks.
func dropRuleLines(text string) string {
	var keep []string
	for _, l := range strings.Split(text, "\n") {
		if separatorRe.MatchString(l) {
			continue
		}
		keep = append(keep, l)
	}
	return strings.Trim(strings.Join(keep, "\n"), "\n")
}

// steadyClaudeTimer replaces the time in Claude's auto-block line, below the last dashed rule only.
func steadyClaudeTimer(lines []string) {
	last := -1
	for i := len(lines) - 1; i >= 0 && i >= len(lines)-40; i-- {
		if dashedRuleRe.MatchString(lines[i]) {
			last = i
			break
		}
	}
	if last < 0 {
		return
	}
	for i := last + 1; i < len(lines); i++ {
		lines[i] = claudeTimerRe.ReplaceAllString(lines[i], "${1}after a timer of its own${2}")
	}
}

var dashedRuleRe = regexp.MustCompile(`^\s*[╌┄]{8,}\s*$`)

// promptCommand is the whole request Claude draws between its two dashed rules just above a permission question (a Bash command, an edit's diff), so a card and a row can show all of it and not the last three lines
// promptContext keeps for telling one ask from the next (#14173, the Beta Tester: a long command showed only its last 2 lines). It is "" unless the nearest non-blank line above the question is a dashed rule and
// the rule that opens the block is within commandMaxLines: any other screen keeps the old three lines. Each line keeps its own indentation, one leading space (the dialog's margin) dropped.
func promptCommand(lines []string, questionAt int) (cmd, note string, missing bool) {
	i, seen := questionAt-1, 0
	var desc []string
	for ; i >= 0; i-- { // Claude's own line or two under the request sit between the closing rule and the question (every real Bash prompt has one)
		t := strings.TrimSpace(lines[i])
		if t == "" {
			continue
		}
		if dashedRuleRe.MatchString(lines[i]) {
			break
		}
		if seen++; seen > descriptionLines {
			// More text than a request's description under the closing rule: when a real Claude dialog (its header, then dashed rules) is above it, the request was never shown whole: Reject only (#14271, Security's extra on #14173)
			if tailUnderRealDialog(lines, i) {
				return "", "", true
			}
			return "", "", false
		}
		desc = append([]string{t}, desc...)
	}
	if i < 0 {
		return "", "", false
	}
	end := i
	for j := end - 1; j >= 0 && j >= end-commandMaxLines; j-- {
		if dashedRuleRe.MatchString(lines[j]) {
			if !requestDialogHeader(lines, j) {
				return "", "", true // two rules and no Claude dialog header above them: not shown whole, so Reject only; never the old three lines with an Allow (#14173, Security)
			}
			block := make([]string, 0, end-j-1)
			for _, l := range lines[j+1 : end] {
				block = append(block, strings.TrimRight(strings.TrimPrefix(l, " "), " \t\r"))
			}
			return strings.Trim(strings.Join(block, "\n"), "\n"), strings.Join(desc, " "), false
		}
	}
	return "", "", true // a closing rule with no opening rule in reach: the request is not shown whole
}

// headerScanLines: how many non-blank lines above the opening rule are searched for the dialog's header; the agent's own description under the header can run to many lines, and must not push it out of reach.
const headerScanLines = 24

// descriptionLines: how many lines of Claude's own (and an agent's) text may sit between the closing dashed rule and the question.
const descriptionLines = 12

var (
	solidRuleRe        = regexp.MustCompile(`^\s*─{8,}\s*$`)
	dialogHeaderLineRe = regexp.MustCompile(`(?i)\b(?:command|files?)\s*$`)
)

// requestDialogHeader says whether the dashed rule at open is the one that opens Claude's request dialog: within a few lines above it, a solid rule and under it the dialog's header ("Bash command", "Edit file", "Create
// file"). Without that header the rules and the question are text something else printed (#14173, Security's SHOULD).
func requestDialogHeader(lines []string, open int) bool {
	seen := 0
	for k := open - 1; k >= 0 && seen < headerScanLines; k-- {
		if strings.TrimSpace(lines[k]) == "" {
			continue
		}
		seen++
		if solidRuleRe.MatchString(lines[k]) {
			for h := k + 1; h < open; h++ {
				if t := strings.TrimSpace(lines[h]); t != "" {
					return dialogHeaderLineRe.MatchString(t)
				}
			}
			return false
		}
	}
	return false
}

// tailUnderRealDialog says whether, looking up from line from (a line of a long tail of text under a rule), a closing dashed rule is within tailScanLines non-blank lines, an opening dashed rule above it, and Claude's dialog
// header above that: the shape of a real request whose own description was made long.
func tailUnderRealDialog(lines []string, from int) bool {
	seen := 0
	for i := from; i >= 0 && seen < tailScanLines; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		seen++
		if !dashedRuleRe.MatchString(lines[i]) {
			continue
		}
		for j := i - 1; j >= 0 && j >= i-commandMaxLines; j-- {
			if dashedRuleRe.MatchString(lines[j]) {
				return requestDialogHeader(lines, j)
			}
		}
		return false
	}
	return false
}

// tailScanLines: how far above the question the closing rule of a request with a very long description is looked for.
const tailScanLines = 200

// withCommand sets the request block, Claude's line under it and the missing-opening-rule flag from the screen above the question.
func (s promptScreen) withCommand(lines []string, questionAt int) promptScreen {
	s.command, s.TargetNote, s.commandOpenMissing = promptCommand(lines, questionAt)
	return s
}

// samePrompt reports whether two reads show the same prompt, wherever its selection is.
func samePrompt(a, b promptScreen) bool {
	if a.Question != b.Question || a.context != b.context || a.command != b.command || len(a.Options) != len(b.Options) {
		return false
	}
	for i := range a.Options {
		if normalizeLabel(a.Options[i].Label) != normalizeLabel(b.Options[i].Label) {
			return false
		}
	}
	return true
}

// parseReview reads the "Review your answers" list shown above the Submit
// step of a multi-question dialog:
//
//	Review your answers
//	 ● What is your favorite fruit?
//	   → Pear
func parseReview(lines []string, questionAt int) []promptReviewItem {
	if questionAt <= 0 {
		return nil
	}
	start := -1
	for i := questionAt - 1; i >= 0 && i >= questionAt-40; i-- {
		if strings.TrimSpace(lines[i]) == "Review your answers" {
			start = i
			break
		}
	}
	if start < 0 {
		return nil
	}
	var items []promptReviewItem
	for _, line := range lines[start+1 : questionAt] {
		// The focused item carries a bar ("│ ● ..."); strip such markers
		t := strings.TrimSpace(strings.TrimLeft(line, reviewMarkers))
		switch {
		case strings.HasPrefix(t, "●"):
			items = append(items, promptReviewItem{Question: strings.TrimSpace(strings.TrimPrefix(t, "●"))})
		case strings.HasPrefix(t, "→") && len(items) > 0:
			items[len(items)-1].Answer = strings.TrimSpace(strings.TrimPrefix(t, "→"))
		case t != "" && len(items) > 0:
			// A long question or answer wraps onto the next line
			last := &items[len(items)-1]
			if last.Answer != "" {
				last.Answer += " " + t
			} else {
				last.Question += " " + t
			}
		}
	}
	return items
}

// Characters Claude Code draws before a review item (focus bar, indent)
const reviewMarkers = " \t│┃▎▍▌|>"

func (h *SessionsHandler) capturePromptScreen(ctx context.Context, name, agentType, sessionID string) (promptScreen, bool) {
	s, ok, err := h.readPromptScreen(ctx, name, agentType, sessionID)
	return s, ok && err == nil
}

// readPromptScreen reads the prompt open on the agent's screen; an error is a screen that couldn't be read,
// which is not a screen without a prompt.
func (h *SessionsHandler) readPromptScreen(ctx context.Context, name, agentType, sessionID string) (promptScreen, bool, error) {
	s, ok, _, err := h.readPromptScreenText(ctx, name, agentType, sessionID)
	return s, ok, err
}

// promptCaptureLines is how much of the pane a prompt is first read from; deepPromptCaptureLines is the read made again when that one shows the closing rule of a request but not the opening rule (#14575): the parser
// walks up commandMaxLines for it, the header and Claude's own lines add a few dozen more, so the window is what the walk can use. It is not a second set of rules: the same parse and the same checks judge what it finds.
const (
	promptCaptureLines     = 80
	deepPromptCaptureLines = commandMaxLines + 60
)

// deepMissCache remembers, for deepMissTTL, a first-read screen (by session and text) whose deeper read still showed no opening rule: the prompt polls run every few dozen milliseconds, and a request that was never
// shown whole must not cost a 460-line capture each time. The first screen changing (another request, a redraw) is another key, so it is read deep again at once; the entries are few (at most deepMissMax) and expire.
type deepMissCache struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

const deepMissMax = 256

var (
	deepMissTTL = 5 * time.Second
	deepMissNow = time.Now
)

func deepMissKey(name, text string) string {
	h := sha256.Sum256([]byte(name + "\x00" + text))
	return hex.EncodeToString(h[:16])
}

func (c *deepMissCache) recent(name, text string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	seenAt, ok := c.seen[deepMissKey(name, text)]
	return ok && deepMissNow().Sub(seenAt) < deepMissTTL
}

func (c *deepMissCache) note(name, text string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := deepMissNow()
	if c.seen == nil || len(c.seen) >= deepMissMax {
		for k, seenAt := range c.seen { // drop what expired; start over when still full
			if now.Sub(seenAt) >= deepMissTTL {
				delete(c.seen, k)
			}
		}
		if c.seen == nil || len(c.seen) >= deepMissMax {
			c.seen = map[string]time.Time{}
		}
	}
	c.seen[deepMissKey(name, text)] = now
}

// screenRows is a screen's rows as compared: each row without its trailing spaces and carriage return, the trailing blank rows dropped.
func screenRows(text string) []string {
	rows := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	for i := range rows {
		rows[i] = strings.TrimRight(rows[i], " \t")
	}
	for len(rows) > 0 && rows[len(rows)-1] == "" {
		rows = rows[:len(rows)-1]
	}
	return rows
}

// deepExtendsFirst reports whether deep ends with every row of first (and so only adds rows above them): the proof that a deeper read is of the same screen as the first.
func deepExtendsFirst(first, deep string) bool {
	f, d := screenRows(first), screenRows(deep)
	if len(f) == 0 || len(d) < len(f) {
		return false
	}
	for i := range f {
		if f[len(f)-1-i] != d[len(d)-1-i] {
			return false
		}
	}
	return true
}

// sameQuestion: the two reads give one question with the same options, in the same order.
func sameQuestion(a, b promptScreen) bool {
	if a.Question != b.Question || len(a.Options) != len(b.Options) {
		return false
	}
	for i := range a.Options {
		if normalizeLabel(a.Options[i].Label) != normalizeLabel(b.Options[i].Label) {
			return false
		}
	}
	return true
}

// readPromptScreenText is readPromptScreen with the screen's text, for a caller that must tell a screen with no menu on it from a
// menu it could not parse.
func (h *SessionsHandler) readPromptScreenText(ctx context.Context, name, agentType, sessionID string) (promptScreen, bool, string, error) {
	var text string
	var err error
	if rs, ok := h.terminal.(ptymanager.RenderedScreenReader); ok {
		text, err = rs.RenderedScreen(ctx, name, agentType, sessionID) // the PTY's output is not the screen as drawn (#4543)
	} else {
		text, err = h.terminal.CaptureOutput(ctx, name, promptCaptureLines, agentType, sessionID)
	}
	if err != nil {
		return promptScreen{}, false, "", err
	}
	s, ok := parseAgentScreen(agentType, text)
	if ok && s.commandOpenMissing && agentType == at.Claude {
		// The closing rule of a request is there and its opening rule is not: the history above the screen may hold it (#14575). tmux gives it as the pane's history; the PTY backend as the scrolled-off rows of its replay
		// ring (CaptureOutput, vtscreen.RenderScrollback), though its first read above is only the screen's rows. Read deeper once; the same parse and the same checks judge what is found, and a request whose top is still
		// not there stays Reject only. The deeper text replaces the first only when it shows the request whole, so every caller (the row, the card, the answer) sees the same screen.
		if !h.deepMiss.recent(name, text) { // a screen the deeper read already missed is not read deep again at every poll (Security's SHOULD, #14581)
			if deep, derr := h.terminal.CaptureOutput(ctx, name, deepPromptCaptureLines, agentType, sessionID); derr == nil {
				// Bound to the first read (Security's MUST on the PTY, #14575): on a PTY the first read is the live screen and the deeper one a replay of a clipped ring, which can draw an older frame or miss rows; on tmux both
				// are one pane. The deeper text is taken only when it ENDS with every row of the first read, so it can only add what is above it (the top of the same request); anything else keeps the first read, Reject only.
				ds, dok := parseAgentScreen(agentType, deep)
				if dok && !ds.commandOpenMissing && deepExtendsFirst(text, deep) && sameQuestion(s, ds) {
					s, text = ds, deep
				} else {
					h.deepMiss.note(name, text) // no top in the deeper read, or it is not the same screen: not read deep again for a few seconds (Security's SHOULD)
				}
			}
		}
	}
	if ok && s.commandOpenMissing && agentType == at.Claude {
		// No read shows the top of the request (the dialog is taller than the terminal and its top is in neither the pane's history nor the PTY's ring, #15492): the call the agent's hook reported before it asked may still be
		// the whole request, when the screen's own part of it is that call's end.
		if whole, wok := h.screenWithStoredRequest(sessionID, text); wok {
			if ws, wsok := parseAgentScreen(agentType, whole); wsok && !ws.commandOpenMissing && sameQuestion(s, ws) {
				s, text = ws, whole
			}
		}
	}
	if ok {
		if agentType == at.Hermes && s.Kind == promptKindApproval {
			applyHermesCommand(&s, h.hermesStoredCommand(ctx, sessionID)) // the screen drops a hidden character; Hermes's stored call has it (#12170)
		}
	}
	return s, ok, text, nil
}

// parseAgentScreen reads the prompt on an agent's screen the way a row, a card and an answer all must: the generic parse, plus the two Claude-only menus that a row may answer (the folder-trust menu, #14110,
// and Claude's browser menu, #14151). Those two are read ONLY when the session's stored agent type is Claude: three lines shaped like either menu printed by a Codex, agy, Gemini or terminal agent's own program
// are not a prompt of Claude's, and an arrow key and Enter into that program would answer whatever it is waiting for (Security's MUST on #14151). Every caller that reads a screen for an offer or an answer comes here, so the
// gate holds at offer time and again at answer time.
func parseAgentScreen(agentType, text string) (promptScreen, bool) {
	s, ok := parsePromptScreenFor(agentType, text)
	if !ok && agentType == at.Claude {
		lines := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
		for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
			lines = lines[:len(lines)-1]
		}
		s, ok = parseBrowserPromptMenu(lines)
	}
	if ok {
		markApprovalKinds(agentType, text, &s)
		if agentType == at.Claude {
			markFolderTrust(text, &s)
		}
		markRateLimit(agentType, &s)
	}
	return s, ok
}

// menuStillDrawn says whether text still shows the menu `before`: at least two of its option labels (or all, for a short
// menu) are on the screen. A screen that does not parse as a prompt is not a prompt that went while this holds (#58).
func menuStillDrawn(text string, before promptScreen) bool {
	if len(before.Options) < 2 {
		return false
	}
	on := normalizeLabel(text)
	found := 0
	for _, o := range before.Options {
		if l := normalizeLabel(o.Label); l != "" && strings.Contains(on, l) {
			found++
		}
	}
	return found >= 2
}

// normalizeLabel is a label in lower case, its white space squeezed, without a selection marker (›, >, ❯, ▶) left at
// its end: a redraw that moved the marker can leave one there, and the menu is the same menu (#58: a menu that only
// looked changed was reported answered).
func normalizeLabel(s string) string {
	s = strings.Join(strings.Fields(strings.ToLower(s)), " ")
	return strings.TrimRight(s, "›>❯▶ ")
}

// AnswerPrompt selects an option of the prompt open in the agent's terminal.
// The screen is re-read first: the digit is sent only if that option still
// has the label the user clicked, so a prompt that changed or closed is
// never answered by mistake.
// POST /api/sessions/live/{name}/answer-prompt {"session_id","agent_type","n","label"}
func (h *SessionsHandler) AnswerPrompt(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var body struct {
		SessionID      string `json:"session_id"`
		AgentType      string `json:"agent_type"`
		N              int    `json:"n"`
		Label          string `json:"label"`
		Text           string `json:"text"`             // the typed answer, for a "text" option
		Submit         bool   `json:"submit"`           // take the Submit row of a multi-select question (#5232); no n or label
		AskID          string `json:"ask_id"`           // the ask the caller drew (a screen's ask_id): another ask now open is refused (#10400); empty: not checked
		RateLimitModel string `json:"rate_limit_model"` // a row's answer to Codex's rate-limit notice names the model it drew: the screen must still be exactly that notice with that model, from the person's own dashboard (#14774); empty: the chat's own answer
		TrustFolder    string `json:"trust_folder"`     // a row's Yes for the folder-trust menu names the folder it drew: the screen must still name it, and Coral may trust it (#14110); empty: the chat's own answer
	}
	if err := decodeJSON(r, &body); err != nil || !body.Submit && (body.N < 1 || body.N > 9 || strings.TrimSpace(body.Label) == "") {
		errBadRequest(w, "n (1-9) and label are required")
		return
	}
	// An answer always names its exact target, as for Send: a bare name would reach
	// whatever pane matches it and could answer another agent's prompt (#3211).
	target, status, message := h.validateExactLiveTarget(r.Context(), name, body.AgentType, body.SessionID, false)
	if status != 0 {
		writeExactTargetError(w, status, message)
		return
	}
	// One prompt is answered or closed by one sender at a time: a person's answer waits for Coral's own close or pick to finish, and each re-reads the screen inside the lock (agent_lock.go). The key is the
	// validated session's own id, the one every watcher locks on, so a request can never take a different key for the same prompt (a name is not one: the target is validated by its session id above).
	defer h.lockAgent(target.SessionID)()
	h.touch(r, body.SessionID, board.TouchAnswer)    // the Operator answers an agent's question (#11225): counted before the keys go, so a typed answer is not counted twice
	if body.SessionID != "" && humanInputCaller(r) { // the Inbox's numbers (#7512): the wait's kind and age, never the agent or the answer
		st := h.deriveSingleSessionState(r.Context(), body.SessionID, 0)
		inboxActioned(r, tracking.InboxAgentWait, st.WaitingKind, "answer", st.WaitingSince)
	}
	// opencode is answered through its own server, not by typing into its terminal (#11395)
	if body.AgentType == at.Opencode && body.SessionID != "" && !body.Submit {
		h.answerOpencodePermission(w, r, body.SessionID, body.N, body.Label, body.AskID)
		return
	}
	// The agent's own terminal is gone: say so, rather than "the prompt changed" (#3211)
	if body.SessionID != "" {
		if pane, err := h.terminal.FindSession(r.Context(), name, body.AgentType, body.SessionID); err == nil && pane == nil {
			writeTerminalError(w, ptymanager.ErrTerminalGone)
			return
		}
	}
	// An agent that reports its prompts through hooks is answered only while its hooks say a request may be open (or a tool is pending): the same condition
	// that offers the card (addNeedsInput). A screen that looks like a menu after the agent has stopped is not one (#5254).
	if body.SessionID != "" && !readsPromptsFromScreen(body.AgentType) {
		if _, pending := h.pending.get(body.SessionID, time.Now()); !pending && !h.hints.mayBeOpen(body.SessionID) {
			writeError(w, http.StatusConflict, "", "The prompt is no longer open. Check the terminal.")
			return
		}
	}
	screen, ok := h.capturePromptScreen(r.Context(), name, body.AgentType, body.SessionID)
	if body.Submit {
		h.submitMulti(w, r, name, body.AgentType, body.SessionID, screen, ok)
		return
	}
	if !ok || body.N > len(screen.Options) {
		errConflict(w, "The prompt is no longer open. Check the terminal.")
		return
	}
	if body.AskID != "" && screen.AskID != body.AskID {
		writeError(w, http.StatusConflict, "ask_changed", "That question changed; look at it again.") // a code the client matches on, not the words (#10516)
		return
	}
	opt := screen.Options[body.N-1]
	if normalizeLabel(opt.Label) != normalizeLabel(body.Label) {
		errConflict(w, "The prompt changed. Answer it in the terminal.")
		return
	}
	if body.TrustFolder != "" && isTrustYes(screen, opt) && (screen.TrustFolder != body.TrustFolder || !h.trustOffered(r, body.SessionID, screen)) { // a row's lasting Yes: only for the folder it showed, a folder Coral may trust, from the person's own dashboard (#14110)
		writeError(w, http.StatusConflict, "trust_changed", "The folder to trust changed or cannot be trusted from here. Answer it in the agent's own chat.")
		return
	}
	if body.RateLimitModel != "" && (body.AgentType != at.Codex || screen.rateLimitModel != body.RateLimitModel || !trustFolderCaller(r)) { // the row's lasting choice: only for the notice and model it showed, from the person's own dashboard (#14774); a changed screen types nothing
		writeError(w, http.StatusConflict, "rate_limit_changed", "The rate-limit notice changed or cannot be answered from here. Answer it in the agent's own chat.")
		return
	}
	if note := h.onlyRejectNote(body.SessionID, screen); note != "" && !optionIsReject(opt) { // a request that cannot be shown whole or hides something is never allowed from here (#11399)
		writeError(w, http.StatusConflict, "only_reject", note)
		return
	}
	// A typed answer is one line: Enter submits the field
	text := strings.Join(strings.Fields(body.Text), " ")
	if opt.Action == "text" && text == "" {
		errBadRequest(w, "text is required for this option")
		return
	}
	if screen.Multi && navigatesByArrows(body.AgentType) {
		errConflict( // Its menus take only arrows and Enter, and an Enter on a box toggles it: no key is sent (#5232)
			w, "Answer this question in the terminal.")
		return
	}
	if screen.Multi && body.N <= screen.boxes {
		h.toggleMulti(w, r, name, body.AgentType, body.SessionID, screen, body.N)
		return
	}
	action := opt.Action
	byArrows := screen.Unnumbered || navigatesByArrows(body.AgentType)
	if byArrows {
		action = "arrows" // its Enter is sent here, never by confirmAnswer
		if moved, err := h.selectUnnumbered(r.Context(), name, body.AgentType, body.SessionID, screen, body.N); err != nil {
			writeTerminalError(w, err)
			return
		} else if !moved {
			writeError(w, http.StatusConflict, "prompt_still_open",
				"The prompt's selection didn't move to that option. Answer it in the terminal.")
			return
		}
	} else if err := h.terminal.SendRawInput(r.Context(), terminalinput.Unclassified, name, []string{strconv.Itoa(body.N)}, body.AgentType, body.SessionID); err != nil {
		writeTerminalError(w, err)
		return
	}
	if opt.Action == "text" && !byArrows {
		// The digit turns the option into a text field; type into it, then Enter
		time.Sleep(promptTextDelay)
		// The text a person typed into the prompt's field: logged by its length (#5715).
		if err := h.terminal.SendInput(r.Context(), terminalinput.Person, name, text, body.AgentType, body.SessionID); err != nil {
			writeTerminalError(w, err)
			return
		}
	}
	h.hints.forget(body.SessionID) // the prompt was answered: the next poll reads what replaced it
	h.forgetPromptReads(body.SessionID, name, body.AgentType)
	cleared, err := h.confirmAnswer(r.Context(), name, body.AgentType, body.SessionID, screen, body.N, action)
	if err != nil {
		writeTerminalError(w, err)
		return
	}
	if !cleared {
		writeError(w, http.StatusConflict, "answer_sent_prompt_open", // the key went and the prompt did not clear: told apart from "prompt_still_open" (nothing was sent), #10516
			"The answer was sent, but the agent's prompt is still open. Check the terminal.")
		return
	}
	h.refreshAfterConfirmedAnswer(r.Context(), body.AgentType, body.SessionID)
	h.retrySkippedBoardNudge(r.Context(), body.SessionID, naming.SessionName(body.AgentType, body.SessionID), "request_resolved")
	at := h.answers.note(body.SessionID, opt.Label)
	row := board.ActPromptAnswer // the Activity row says what the Operator chose, by the option's own kind, with its label as the note (#13609): never a guess from the session name
	switch {
	case opt.Kind == "allow_once" || opt.Kind == "allow_always":
		row = board.ActPromptAllow
	case optionIsReject(opt):
		row = board.ActPromptReject
	}
	note := opt.Label
	if body.TrustFolder != "" && isTrustYes(screen, opt) {
		note = opt.Label + ": " + screen.TrustFolder // the grant can be found later: who, which agent, which folder (#14110)
	}
	// The row says it answered a trust dialog, whichever option was taken (#16129).
	noteActivity(r, row, "agent", name, "", trustDialogTitle(screen), note)
	h.kickWS()                     // every screen showing the card takes the answer now
	h.forgetDialog(body.SessionID) // the prompt was answered: it is not a dialog the agent is stuck at (#11437); the next pass reads the screen again
	// One line on success too (#16398: a report that an answer "changed nothing" had no log to show whether it reached the terminal): who, which option, how it was sent, never the question or any typed text.
	slog.Info("answer-prompt sent", "session", name, "agent_type", body.AgentType, "session_id", body.SessionID, "n", body.N, "kind", answerKind(screen, opt, body.TrustFolder != ""), "by", map[bool]string{true: "arrows", false: "digit"}[byArrows], "trust_folder", body.TrustFolder != "" && isTrustYes(screen, opt))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "answered": opt.Label, "at": at})
}

// answeredNoteFor is how long a prompt's answer is kept for another screen to say "Answered X from another device".
const answeredNoteFor = 2 * time.Minute

// promptAnswers is the last prompt answered per agent (session id): its option's label and when (Unix milliseconds). Its zero value is ready.
type promptAnswers struct {
	mu sync.Mutex
	m  map[string]struct {
		label string
		at    int64
	}
}

// note records an answer and returns its time.
func (p *promptAnswers) note(sessionID, label string) int64 {
	if sessionID == "" {
		return 0
	}
	at := time.Now().UnixMilli()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.m == nil {
		p.m = map[string]struct {
			label string
			at    int64
		}{}
	}
	for id, v := range p.m {
		if time.Since(time.UnixMilli(v.at)) > answeredNoteFor {
			delete(p.m, id) // answers older than the note's life are dropped as new ones come: the map stays as small as the agents recently answered
		}
	}
	p.m[sessionID] = struct {
		label string
		at    int64
	}{label, at}
	return at
}

// lastAnswerOf is the live row's last_answer: {label, at} for an answer given in the last two minutes, else nil (a null).
func (h *SessionsHandler) lastAnswerOf(sessionID string) any {
	p := &h.answers
	p.mu.Lock()
	defer p.mu.Unlock()
	v, ok := p.m[sessionID]
	if !ok || time.Since(time.UnixMilli(v.at)) > answeredNoteFor {
		return nil
	}
	// The option's words are the agent's own text: through the same cleaning and redaction as a waiting line before they reach a row (and so the Hub), and none when they cannot be checked (#10301, Security).
	line, _ := waitingLine(v.label).(string)
	label := []rune(line)
	if len(label) > 80 {
		label = append(label[:80], '…')
	}
	return map[string]any{"label": string(label), "at": v.at}
}

// navigatesByArrows: agent CLIs whose menus ignore a digit and take only the arrow keys and Enter, even when
// their options are numbered ("↑/↓ Navigate · enter Select"): Antigravity, which "gemini" launches too
// (#4577, verified on agy 1.4.2: a digit leaves the selection where it was).
func navigatesByArrows(agentType string) bool {
	switch agentType {
	case at.Agy, at.Antigravity, at.Gemini:
		return true
	}
	return false
}

// selectUnnumbered answers option n of a menu answered with the arrow keys (one without numbers, or any menu
// of an agent that navigatesByArrows): the arrows move its selection from the option selected now, and Enter
// is sent only once the screen shows the same menu with option n selected.
// It reports false, having sent no Enter, when that isn't seen in time (the menu changed or went).
func (h *SessionsHandler) selectUnnumbered(ctx context.Context, name, agentType, sessionID string, before promptScreen, n int) (bool, error) {
	as, isArrow := h.terminal.(ptymanager.ArrowSender)
	es, isEnter := h.terminal.(ptymanager.EnterSender)
	if !isArrow || !isEnter {
		return false, nil
	}
	from := 0
	for i, o := range before.Options {
		if o.Selected {
			from = i + 1
		}
	}
	steps, up := n-from, n < from
	if up {
		steps = -steps
	}
	for i := 0; i < steps; i++ {
		if err := as.SendArrow(ctx, name, agentType, sessionID, up); err != nil {
			return false, err
		}
	}
	deadline := time.Now().Add(promptClearTimeout)
	for {
		now, ok, err := h.readPromptScreen(ctx, name, agentType, sessionID)
		if err == nil && ok && samePrompt(before, now) && now.Options[n-1].Selected {
			return true, es.SendEnter(ctx, name, agentType, sessionID)
		}
		if err == nil && (!ok || !samePrompt(before, now)) || time.Now().After(deadline) {
			return false, nil
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(promptPollEvery):
		}
	}
}

// confirmAnswer waits, a bounded time, for the prompt an answer was sent to to go, and says whether it went.
// Codex has menus a digit answers (its sign-in choice) and menus where a digit only moves the selection and
// Enter confirms it (its hook review, "Press enter to confirm"; #4543): for a Codex select option, while the
// same prompt stays up with that option selected for promptSettle, Enter is sent once. Claude Code's digits
// answer, so it never gets an Enter here. The screen is what is read: Codex runs no hook before its trust
// menus are answered, so there is no event to wait for.
func (h *SessionsHandler) confirmAnswer(ctx context.Context, name, agentType, sessionID string, before promptScreen, n int, action string) (bool, error) {
	mayConfirm := agentType == at.Codex && action == "select"
	deadline := time.Now().Add(promptClearTimeout)
	var heldSince time.Time
	for {
		now, ok, text, err := h.readPromptScreenText(ctx, name, agentType, sessionID)
		drawn := menuStillDrawn(text, before)
		// Gone: no prompt parses and the menu is not on screen, or another prompt parses and the menu is not on screen
		// either. A menu still drawn whose question or context text changed (a count in a header) is not yet gone.
		if err == nil && !drawn && (!ok || !samePrompt(before, now)) {
			return true, nil
		}
		// The retry Enter goes only to the same prompt, whatever the early return above does (Security's N1). Two
		// consecutive prompts with the same question and options cannot be told apart: one such Enter could reach the
		// next, which needs that option selected and held for promptSettle, and is accepted (N3).
		if err == nil && mayConfirm && ok && samePrompt(before, now) && n <= len(now.Options) && now.Options[n-1].Selected {
			if heldSince.IsZero() {
				heldSince = time.Now()
			} else if time.Since(heldSince) >= promptSettle {
				es, isSender := h.terminal.(ptymanager.EnterSender)
				if !isSender {
					return false, nil
				}
				if err := es.SendEnter(ctx, name, agentType, sessionID); err != nil {
					return false, err
				}
				mayConfirm = false // one Enter, never a second into whatever comes next
				deadline = time.Now().Add(promptClearTimeout)
			}
		} else {
			heldSince = time.Time{}
		}
		if time.Now().After(deadline) {
			return false, nil
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(promptPollEvery):
		}
	}
}

// toggleMulti flips the box of option n of a multi-select question: its digit toggles it and answers nothing.
// The box is confirmed from the screen (it must have flipped, on the same prompt) and the screen read is the
// reply, so the card shows what the terminal shows (#5232).
func (h *SessionsHandler) toggleMulti(w http.ResponseWriter, r *http.Request, name, agentType, sessionID string, before promptScreen, n int) {
	if err := h.terminal.SendRawInput(r.Context(), terminalinput.Unclassified, name, []string{strconv.Itoa(n)}, agentType, sessionID); err != nil {
		writeTerminalError(w, err)
		return
	}
	h.hints.forget(sessionID)
	want := !before.Options[n-1].Checked
	now, ok, err := h.waitPromptScreen(r.Context(), name, agentType, sessionID, func(s promptScreen) bool {
		return samePrompt(before, s) && n <= len(s.Options) && s.Options[n-1].Checked == want
	})
	if err != nil {
		writeTerminalError(w, err)
		return
	}
	if !ok {
		writeError(w, http.StatusConflict, "prompt_still_open",
			"The box didn't change. Check the terminal.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "toggled": before.Options[n-1].Label, "checked": want, "prompt_options": now})
}

// maxMultiDowns bounds the Down presses one Submit sends: a multi-select question has a handful of options.
const maxMultiDowns = 12

// submitMulti takes the Submit row of a multi-select question: Down moves the selection from the option it is on
// to the row under the last box, and Enter is sent only once the screen shows that row selected. The prompt
// must go (the next question, or the review step) for the answer to be ok.
func (h *SessionsHandler) submitMulti(w http.ResponseWriter, r *http.Request, name, agentType, sessionID string, before promptScreen, shown bool) {
	if !shown || !before.Multi || before.Submit == nil {
		errConflict(w, "There is no Submit row on the terminal now. Check the terminal.")
		return
	}
	as, isArrow := h.terminal.(ptymanager.ArrowSender)
	es, isEnter := h.terminal.(ptymanager.EnterSender)
	if !isArrow || !isEnter || navigatesByArrows(agentType) {
		errConflict(w, "Submit it in the terminal.")
		return
	}
	steps := 0
	if !before.Submit.Focused {
		from := 0
		for i, o := range before.Options {
			if o.Selected {
				from = i + 1
			}
		}
		if from < 1 || from > before.boxes {
			errConflict(w, "The selection is not on a box. Submit it in the terminal.")
			return
		}
		steps = before.boxes - from + 1
	}
	if steps > maxMultiDowns {
		errConflict(w, "Too many options to reach Submit from here. Submit it in the terminal.")
		return
	}
	for i := 0; i < steps; i++ {
		if err := as.SendArrow(r.Context(), name, agentType, sessionID, false); err != nil {
			writeTerminalError(w, err)
			return
		}
	}
	h.hints.forget(sessionID)
	_, ok, err := h.waitPromptScreen(r.Context(), name, agentType, sessionID, func(s promptScreen) bool {
		return samePrompt(before, s) && s.Submit != nil && s.Submit.Focused
	})
	if err != nil {
		writeTerminalError(w, err)
		return
	}
	if !ok {
		writeError(w, http.StatusConflict, "prompt_still_open",
			"The selection didn't reach Submit. Submit it in the terminal.")
		return
	}
	if err := es.SendEnter(r.Context(), name, agentType, sessionID); err != nil {
		writeTerminalError(w, err)
		return
	}
	h.forgetPromptReads(sessionID, name, agentType)
	cleared, err := h.confirmAnswer(r.Context(), name, agentType, sessionID, before, 0, "arrows")
	if err != nil {
		writeTerminalError(w, err)
		return
	}
	if !cleared {
		writeError(w, http.StatusConflict, "answer_sent_prompt_open", // the key went and the prompt did not clear: told apart from "prompt_still_open" (nothing was sent), #10516
			"Submit was sent, but the agent's prompt is still open. Check the terminal.")
		return
	}
	h.refreshAfterConfirmedAnswer(r.Context(), agentType, sessionID)
	h.retrySkippedBoardNudge(r.Context(), sessionID, naming.SessionName(agentType, sessionID), "request_resolved")
	h.forgetDialog(sessionID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "answered": before.Submit.Label})
}

// waitPromptScreen reads the prompt screen until done accepts it, for at most promptClearTimeout. ok is false when it
// never did (the prompt went or changed, or time ran out).
func (h *SessionsHandler) waitPromptScreen(ctx context.Context, name, agentType, sessionID string, done func(promptScreen) bool) (promptScreen, bool, error) {
	deadline := time.Now().Add(promptClearTimeout)
	for {
		now, ok, err := h.readPromptScreen(ctx, name, agentType, sessionID)
		if err == nil && ok && done(now) {
			return now, true, nil
		}
		if time.Now().After(deadline) {
			return now, false, nil
		}
		select {
		case <-ctx.Done():
			return promptScreen{}, false, ctx.Err()
		case <-time.After(promptPollEvery):
		}
	}
}

// wrapsInto reports whether above can be the line a wrapped text broke before below: a terminal (or the CLI) wraps a word onto
// the next line only when it does not fit, so the line above is never short enough to have taken below's first word (#306).
// below is the full width the text had, so a line whose length plus that word fits within it was not wrapped.
func wrapsInto(above, below string) bool {
	first, _, _ := strings.Cut(below, " ")
	return utf8.RuneCountInString(above)+1+utf8.RuneCountInString(first) > utf8.RuneCountInString(below)
}

// onlyRejectNote is the sentence that says the open request can only be rejected here ("" when it can be allowed): the pending tool the hook reported, or the screen's own prompt.
func (h *SessionsHandler) onlyRejectNote(sessionID string, screen promptScreen) string {
	if screen.OnlyReject {
		return screen.Note
	}
	if sessionID != "" {
		if t, ok := h.pending.get(sessionID, time.Now()); ok {
			if only, _ := t.Input["only_reject"].(bool); only {
				note, _ := t.Input["note"].(string)
				return note
			}
		}
	}
	return ""
}

// rejectLabel matches the answers that refuse a request, where nothing but the words says so: Claude's "No", Codex's "No, and tell Codex what to do differently (esc)", agy's "No, cancel", "Reject", "Deny", "Decline", "Disallow", "Don't allow",
// "Cancel", "Not now" ("Skip" is not one: Codex's "Skip all approvals this session" is a standing choice, not a refusal) (the captured screens' own words are in testdata; the card has the same list as its fallback, needs_input_card.js).
var rejectLabel = regexp.MustCompile(`(?i)^(no|reject|deny|denied|decline|disallow|cancel|not now|don['’]?t allow|do not allow)\b`)

func isRejectLabel(label string) bool { return rejectLabel.MatchString(strings.TrimSpace(label)) }

// allowLabel matches an answer that allows: the Yes rows of an approval.
var allowLabel = regexp.MustCompile(`(?i)^(yes|allow|approve|proceed|run)\b`)

// answerKind is the option's kind for the log line: one of a fixed set, never its words (an option can name a folder or a command, "Yes, allow reading from <dir>", #16440).
func answerKind(screen promptScreen, opt promptOption, trustAsked bool) string {
	switch {
	case trustAsked && isTrustYes(screen, opt):
		return "trust"
	case opt.Kind == "allow_once" || opt.Kind == "allow_always":
		return "allow"
	case optionIsReject(opt):
		return "deny"
	case strings.HasPrefix(strings.ToLower(strings.TrimSpace(opt.Label)), "yes"):
		return "allow"
	}
	return "other"
}

// optionIsReject says whether answering this option refuses the request. Where the option has a kind (it is the approval table's approve-once option, or one of an opencode card's own answers) the KIND decides:
// an option that allows is not a reject whatever its words begin with. Only an option with no kind is judged by its label (^(no|reject|deny|cancel)\b: "None" and "Nothing" are not rejects). Security's #11399 INFO 5.
func optionIsReject(o promptOption) bool {
	switch o.Kind {
	case "reject":
		return true
	case "allow_once", "allow_always":
		return false
	}
	return isRejectLabel(o.Label)
}

// markApprovalKinds gives the approve-once option of a recognised tool approval its kind, from the approval table (the digit it answers with), so the only_reject check does not rest on that option's words.
func markApprovalKinds(agentType, screenText string, s *promptScreen) {
	d := classifyApproval(agentType, screenText)
	if !d.Prompt || !d.Approve || d.N <= 0 {
		return
	}
	for i := range s.Options {
		switch {
		case s.Options[i].N == d.N:
			s.Options[i].Kind = "allow_once"
		case isRejectLabel(s.Options[i].Label):
			s.Options[i].Kind = "reject" // a refusal of a recognised approval: the card keeps it by this, not by its words (#11399)
		case allowLabel.MatchString(strings.TrimSpace(s.Options[i].Label)):
			s.Options[i].Kind = "allow_always" // the other Yes rows (don't ask again, always allow, switch mode): they last past this one answer
		}
	}
}

// activityTrustDialog is the title of an Activity row for an answer to a trust dialog (#16129): the dashboard files every such row under Permissions, whichever option was taken ("No, quit" and "Continue without
// trusting" too, whose labels do not say "trust"). The page reads this word; it is a kind, not text from the screen.
const activityTrustDialog = "Trust dialog"

// trustDialogOf says whether the screen is a dialog that asks whether to trust something, by its structure and not by an option's words: Codex's hooks review ("Hooks need review"), Codex's "Do you trust the
// files in this folder?" and Claude's folder-trust menu (it names its folder). An agent's own question that says "trust" is none of these.
func trustDialogOf(s promptScreen) bool {
	if s.TrustFolder != "" {
		return true
	}
	for _, text := range []string{s.Title, s.Question} {
		t := strings.ToLower(strings.TrimSpace(text))
		if strings.HasPrefix(t, "hooks need review") || strings.HasPrefix(t, "do you trust the files") {
			return true
		}
	}
	return false
}

// trustDialogTitle is the Activity row's title for an answer to screen: the trust-dialog kind, or "".
func trustDialogTitle(s promptScreen) string {
	if trustDialogOf(s) {
		return activityTrustDialog
	}
	return ""
}
