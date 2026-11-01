package main

// Scripted dialogs (#422, the live checks of goal #14): in raw-input mode a line MOCK_DIALOG <name> opens a dialog drawn the way Claude Code draws its own: an AskUserQuestion
// question (single or multi-select), a permission prompt, a plan approval, the review step of a question, or any screen given line by line. The specs come from the JSON file
// MOCK_AGENT_DIALOGS ({"<name>": spec, ...}, see dialogSpec). A spec also says which hook events go with the dialog (the live call, a stale record, or none), whether a program
// other than the CLI draws it (a stranger in the terminal), whether it opens a while after the line (so a draft can be typed first), and whether it changes while open.
//
// Every key the dialog gets, and how it ended, is a JSON line in MOCK_AGENT_RAW_DIR/<session>.dialog.jsonl ({"event": "open" | "key" | "toggle" | "answer" | "dismiss" |
// "change" | "stranger_key" | ...}), so a test can say what reached which dialog: a digit in a dialog that should have been refused shows there as a "key" with "digit": true.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/term"
)

type dialogOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// dialogSpec is one dialog of MOCK_AGENT_DIALOGS.
type dialogSpec struct {
	Kind     string         `json:"kind,omitempty"`     // question (the default), permission, plan, review or screen
	Tool     string         `json:"tool,omitempty"`     // the tool the hook events name: AskUserQuestion, Bash or ExitPlanMode by kind; a screen has none unless given
	Header   string         `json:"header,omitempty"`   // a question's tab ("Color"); a permission's heading ("Bash command")
	Question string         `json:"question,omitempty"` // the question line (a permission's and a plan's have a default)
	Context  []string       `json:"context,omitempty"`  // a permission's command, a plan's text, a review's answer lines
	Lines    []string       `json:"lines,omitempty"`    // a screen: drawn as given
	Options  []dialogOption `json:"options,omitempty"`  // a screen's options are not drawn (they are in its lines): they map its digits
	Multi    bool           `json:"multi,omitempty"`    // a question with a box per option and a Submit row
	NoExtras bool           `json:"no_extras,omitempty"`
	Hook     string         `json:"hook,omitempty"` // live (the default): PreToolUse and PermissionRequest now, PostToolUse at the answer; stale: a finished call's PreToolUse and PostToolUse, then the dialog; none
	// Stranger: the dialog is drawn by another program the mock starts in its terminal (a child holding the terminal, as a tool's program would), which logs what it is sent and answers
	// nothing; it ends at an Escape or a Ctrl-C, or after StrangerSecs (60 by default).
	Stranger     bool    `json:"stranger,omitempty"`
	StrangerSecs float64 `json:"stranger_secs,omitempty"`
	OpenAfter    float64 `json:"open_after_s,omitempty"`   // seconds before it opens (the line's turn waits; a draft typed meanwhile stays in the box)
	ChangeAfter  float64 `json:"change_after_s,omitempty"` // seconds after it opens, it is redrawn as ChangeTo (the same call, another ask on screen)
	ChangeTo     string  `json:"change_to,omitempty"`
}

// dialogRow is one row of a drawn dialog: n is its number (0: unnumbered, the Submit row and a multi-select's "Chat about this").
type dialogRow struct {
	n     int
	label string
	desc  string
	role  string // option, text ("Type something." / "Tell Claude what to change"), chat, submit
	boxed bool
}

// dialogs is the mock's dialog state: at most one open at a time.
type dialogs struct {
	mu      sync.Mutex
	specs   map[string]dialogSpec
	specErr string
	logPath string
	session string
	fire    func(event string, extra map[string]any) // hook events, in order, off the read loop
	seq     int

	open    bool
	gen     int
	name    string
	spec    dialogSpec
	rows    []dialogRow
	focus   int
	checked map[int]bool
	typing  bool
	typed   strings.Builder
	toolID  string
	drawn   int // lines the dialog takes on screen, to clear it
	pending bool
}

// newDialogs reads MOCK_AGENT_DIALOGS (a missing or bad file is said once, at the first MOCK_DIALOG).
func newDialogs(dir, session string, fire func(string, map[string]any)) *dialogs {
	d := &dialogs{session: session, fire: fire, specs: map[string]dialogSpec{}}
	if dir != "" {
		d.logPath = filepath.Join(dir, session+".dialog.jsonl")
	}
	d.specs, d.specErr = loadDialogSpecs(os.Getenv("MOCK_AGENT_DIALOGS"))
	return d
}

func loadDialogSpecs(path string) (map[string]dialogSpec, string) {
	if path == "" {
		return map[string]dialogSpec{}, "MOCK_AGENT_DIALOGS is not set"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]dialogSpec{}, err.Error()
	}
	var specs map[string]dialogSpec
	if err := json.Unmarshal(data, &specs); err != nil {
		return map[string]dialogSpec{}, "MOCK_AGENT_DIALOGS: " + err.Error()
	}
	return specs, ""
}

func (d *dialogs) isOpen() bool {
	if d == nil {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.open
}

func (d *dialogs) log(event string, extra map[string]any) {
	if d.logPath == "" {
		return
	}
	rec := map[string]any{"t": time.Now().UTC().Format(time.RFC3339Nano), "event": event, "dialog": d.name, "tool_use_id": d.toolID}
	for k, v := range extra {
		rec[k] = v
	}
	line, _ := json.Marshal(rec)
	f, err := os.OpenFile(d.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	_, _ = f.Write(append(line, '\n'))
	f.Close()
}

func (d *dialogs) hook(event string, extra map[string]any) {
	if d.fire != nil {
		d.fire(event, extra)
	}
}

// start handles MOCK_DIALOG <name>; it says whether the dialog is (or will be) open, so the line's turn waits for its answer.
func (d *dialogs) start(name string) bool {
	d.mu.Lock()
	spec, ok := d.specs[name]
	if !ok {
		why := d.specErr
		if why == "" {
			why = "no such dialog"
		}
		d.mu.Unlock()
		fmt.Printf("\r\n[mock-agent] MOCK_DIALOG %q: %s\r\n", name, why)
		return false
	}
	if d.open || d.pending {
		d.mu.Unlock()
		fmt.Print("\r\n[mock-agent] MOCK_DIALOG: a dialog is already open\r\n")
		return false
	}
	if spec.Stranger {
		d.mu.Unlock()
		d.runStranger(name, spec)
		return false
	}
	if spec.OpenAfter > 0 {
		d.pending = true
		d.mu.Unlock()
		fmt.Printf("\r\n[mock-agent] dialog %s opens in %gs\r\n", name, spec.OpenAfter)
		time.AfterFunc(time.Duration(spec.OpenAfter*float64(time.Second)), func() {
			d.mu.Lock()
			d.pending = false
			d.openLocked(name, spec, true)
			d.mu.Unlock()
		})
		return true
	}
	d.openLocked(name, spec, false)
	d.mu.Unlock()
	return true
}

// toolOf is the tool the spec's hook events name.
func (s dialogSpec) toolOf() string {
	if s.Tool != "" {
		return s.Tool
	}
	switch s.Kind {
	case "permission":
		return "Bash"
	case "plan":
		return "ExitPlanMode"
	case "screen":
		return ""
	}
	return "AskUserQuestion"
}

func (s dialogSpec) toolInput() map[string]any {
	switch s.Kind {
	case "permission":
		return map[string]any{"command": strings.Join(s.Context, "\n"), "description": s.Header}
	case "plan":
		return map[string]any{"plan": strings.Join(s.Context, "\n")}
	}
	opts := make([]any, len(s.Options))
	for i, o := range s.Options {
		opts[i] = map[string]any{"label": o.Label, "description": o.Description}
	}
	return map[string]any{"questions": []any{map[string]any{"header": s.Header, "question": s.Question, "multiSelect": s.Multi, "options": opts}}}
}

// openLocked opens the dialog: its hook events (by spec.Hook), then its drawing. d.mu is held.
func (d *dialogs) openLocked(name string, spec dialogSpec, late bool) {
	d.seq++
	d.gen++
	d.open, d.name, d.spec, d.focus, d.checked, d.typing = true, name, spec, 0, map[int]bool{}, false
	d.typed.Reset()
	d.rows = dialogRows(spec)
	d.toolID = fmt.Sprintf("toolu_mock_d%d_%s", d.seq, short(d.session))
	tool := spec.toolOf()
	switch {
	case tool == "" || spec.Hook == "none":
	case spec.Hook == "stale": // a call that already finished: its record is there, the dialog on screen is not its
		stale := d.toolID + "_stale"
		d.hook("PreToolUse", map[string]any{"tool_name": tool, "tool_use_id": stale, "tool_input": spec.toolInput()})
		d.hook("PostToolUse", map[string]any{"tool_name": tool, "tool_use_id": stale, "tool_response": map[string]any{"answers": map[string]any{}}})
	default:
		d.hook("PreToolUse", map[string]any{"tool_name": tool, "tool_use_id": d.toolID, "tool_input": spec.toolInput()})
		d.hook("PermissionRequest", map[string]any{"tool_name": tool, "tool_use_id": d.toolID, "tool_input": spec.toolInput()})
		if spec.Kind == "permission" || spec.Kind == "plan" {
			d.hook("Notification", map[string]any{"notification_type": "permission_prompt", "message": "Claude needs your permission to use " + tool})
		}
	}
	d.log("open", map[string]any{"kind": kindOf(spec), "hook": hookOf(spec), "late": late})
	if late {
		fmt.Print("\r\n")
	}
	fmt.Print("\r\x1b[K")
	d.drawLocked()
	if spec.ChangeAfter > 0 && spec.ChangeTo != "" {
		gen := d.gen
		time.AfterFunc(time.Duration(spec.ChangeAfter*float64(time.Second)), func() { d.change(gen) })
	}
}

func kindOf(s dialogSpec) string {
	if s.Kind == "" {
		return "question"
	}
	return s.Kind
}

func hookOf(s dialogSpec) string {
	if s.Hook == "" {
		return "live"
	}
	return s.Hook
}

// change redraws the open dialog (generation gen) as its spec's ChangeTo: the same call, another ask on screen.
func (d *dialogs) change(gen int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	next, ok := d.specs[d.spec.ChangeTo]
	if !d.open || d.gen != gen || !ok {
		return
	}
	d.eraseLocked()
	d.log("change", map[string]any{"to": d.spec.ChangeTo})
	d.name, d.spec, d.focus, d.checked, d.typing = d.spec.ChangeTo, next, 0, map[int]bool{}, false
	d.rows = dialogRows(next)
	d.drawLocked()
}

// dialogRows are the rows of a spec, numbered as Claude Code numbers them.
func dialogRows(s dialogSpec) []dialogRow {
	opts := s.Options
	if len(opts) == 0 {
		switch s.Kind {
		case "permission":
			opts = []dialogOption{{Label: "Yes"}, {Label: "Yes, and don't ask again for this command"}, {Label: "No, and tell Claude what to do differently (esc)"}}
		case "plan":
			opts = []dialogOption{{Label: "Yes, and use auto mode"}, {Label: "Yes, manually approve edits"}, {Label: "Tell Claude what to change"}}
		case "review":
			opts = []dialogOption{{Label: "Submit answers"}, {Label: "Cancel"}}
		}
	}
	var rows []dialogRow
	for i, o := range opts {
		role := "option"
		if action := optionRole(o.Label); action != "" {
			role = action
		}
		rows = append(rows, dialogRow{n: i + 1, label: o.Label, desc: o.Description, role: role, boxed: s.Multi})
	}
	if kindOf(s) == "question" && !s.NoExtras {
		n := len(rows) + 1
		if s.Multi {
			rows = append(rows, dialogRow{n: n, label: "Type something", role: "option", boxed: true},
				dialogRow{label: "Submit", role: "submit"}, dialogRow{label: "Chat about this", role: "chat"})
		} else {
			rows = append(rows, dialogRow{n: n, label: "Type something.", role: "text"}, dialogRow{n: n + 1, label: "Chat about this", role: "chat"})
		}
	} else if s.Multi {
		rows = append(rows, dialogRow{label: "Submit", role: "submit"})
	}
	return rows
}

func optionRole(label string) string {
	l := strings.ToLower(strings.TrimSpace(label))
	switch {
	case strings.HasPrefix(l, "type something."), strings.HasPrefix(l, "tell claude what to change"):
		return "text"
	case strings.HasPrefix(l, "chat about this"):
		return "chat"
	}
	return ""
}

func dialogWidth() int {
	if w, _, err := term.GetSize(int(os.Stdout.Fd())); err == nil && w > 20 {
		return w
	}
	return 80
}

// wrapWords breaks s into lines of at most width runes, at spaces where it can.
func wrapWords(s string, width int) []string {
	if width < 10 {
		width = 10
	}
	var out []string
	for _, para := range strings.Split(s, "\n") {
		line := ""
		for _, w := range strings.Fields(para) {
			for utf8.RuneCountInString(w) > width { // a word longer than a line is cut
				if line != "" {
					out = append(out, line)
					line = ""
				}
				r := []rune(w)
				out = append(out, string(r[:width]))
				w = string(r[width:])
			}
			switch {
			case line == "":
				line = w
			case utf8.RuneCountInString(line)+1+utf8.RuneCountInString(w) <= width:
				line += " " + w
			default:
				out = append(out, line)
				line = w
			}
		}
		out = append(out, line)
	}
	return out
}

// render is the dialog as Claude Code draws it, one string per screen row (none longer than width-1, so the terminal wraps nothing).
func (d *dialogs) render(width int) []string {
	s, w := d.spec, width-1
	sep := strings.Repeat("─", min(w, 100))
	var out []string
	add := func(lines ...string) { out = append(out, lines...) }
	wrapped := func(prefix, cont, text string) {
		for i, l := range wrapWords(text, w-utf8.RuneCountInString(prefix)) {
			if i == 0 {
				add(prefix + l)
			} else {
				add(cont + l)
			}
		}
	}
	pointer := func(i int) string {
		if i == d.focus {
			return "❯"
		}
		return " "
	}
	optionRows := func(lead string) {
		for i, r := range d.rows {
			if r.role == "submit" {
				add(pointer(i) + "    " + r.label)
				continue
			}
			if r.n == 0 { // a multi-select's "Chat about this", under a rule
				add(sep, lead+"  "+r.label)
				continue
			}
			if r.role == "chat" && !r.boxed {
				add(sep)
			}
			text := r.label
			if r.boxed {
				box := " "
				if d.checked[r.n] {
					box = "✔"
				}
				text = "[" + box + "] " + text
			}
			num := fmt.Sprintf("%d. ", r.n)
			wrapped(lead+pointer(i)+" "+num, lead+strings.Repeat(" ", 2+len(num)), text)
			if r.desc != "" {
				wrapped(lead+"     ", lead+"     ", r.desc)
			}
		}
	}
	switch kindOf(s) {
	case "screen":
		add(s.Lines...)
	case "permission":
		head := s.Header
		if head == "" {
			head = s.toolOf() + " command"
		}
		add(sep, " "+head, "")
		for _, c := range s.Context {
			wrapped("   ", "   ", c)
		}
		q := s.Question
		if q == "" {
			q = "Do you want to proceed?"
		}
		add("")
		wrapped(" ", " ", q)
		optionRows(" ")
		add("", " Esc to cancel · Tab to amend")
	case "plan":
		dash := strings.Repeat("╌", min(w, 100))
		add(" Here is Claude's plan:", dash)
		for _, c := range s.Context {
			wrapped(" ", " ", c)
		}
		add(dash, sep)
		q := s.Question
		if q == "" {
			q = "Claude has written up a plan and is ready to execute. Would you like to proceed?"
		}
		wrapped(" ", " ", q)
		optionRows(" ")
		add(" ctrl+g to edit in Vim · ~/.claude/plans/mock-plan.md")
	case "review":
		head := s.Header
		if head == "" {
			head = "Question"
		}
		add("←  ☒ "+head+"  ✔ Submit  →", "Review your answers")
		add(s.Context...)
		add("Ready to submit your answers?")
		optionRows("")
	default:
		if s.Multi {
			add(sep, " ← ☐ "+s.Header+"  ✔ Submit →", "")
		} else {
			add(sep, " ☐ "+s.Header, "")
		}
		wrapped("", "", s.Question)
		add("")
		optionRows("")
		add("", "Enter to select · ↑/↓ to navigate · Esc to cancel")
	}
	return out
}

// drawLocked draws the dialog from the cursor's row down and remembers how many rows it took.
func (d *dialogs) drawLocked() {
	lines := d.render(dialogWidth())
	fmt.Print(strings.Join(lines, "\r\n") + "\r\n")
	d.drawn = len(lines)
}

// eraseLocked clears the dialog from the screen (back to its first row), as the CLI does when it closes or redraws one.
func (d *dialogs) eraseLocked() {
	if d.drawn > 0 {
		fmt.Printf("\x1b[%dA\r\x1b[J", d.drawn)
	}
	d.drawn = 0
}

// feed takes the keys at the start of data while a dialog is open; it returns how many bytes it used, 0 when no dialog is open (the input box takes them).
func (d *dialogs) feed(data []byte) int {
	if d == nil {
		return 0
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.open || len(data) == 0 {
		return 0
	}
	c := data[0]
	if d.typing { // the text line: text goes into the answer, an Enter sends it, an Escape dismisses the dialog
		d.log("key", map[string]any{"key": string(c), "digit": c >= '0' && c <= '9', "typing": true})
		switch c {
		case '\r':
			d.closeLocked("answer", map[string]any{"text": d.typed.String()}, kindOf(d.spec) == "question") // a plan's "Tell Claude what to change" is no approval
		case 0x1b:
			d.closeLocked("dismiss", nil, false)
		case 0x7f, 0x08:
			if r := []rune(d.typed.String()); len(r) > 0 {
				d.typed.Reset()
				d.typed.WriteString(string(r[:len(r)-1]))
			}
		default:
			d.typed.WriteByte(c)
		}
		return 1
	}
	if c == 0x1b {
		if len(data) >= 3 && data[1] == '[' && (data[2] == 'A' || data[2] == 'B') {
			d.log("key", map[string]any{"key": string(data[:3]), "digit": false})
			if data[2] == 'A' && d.focus > 0 {
				d.focus--
			} else if data[2] == 'B' && d.focus < len(d.rows)-1 {
				d.focus++
			}
			d.eraseLocked()
			d.drawLocked()
			return 3
		}
		d.log("key", map[string]any{"key": "\x1b", "digit": false})
		d.closeLocked("dismiss", nil, false)
		return 1
	}
	d.log("key", map[string]any{"key": string(c), "digit": c >= '0' && c <= '9'})
	switch {
	case c >= '1' && c <= '9':
		for i, r := range d.rows {
			if r.n == int(c-'0') {
				d.focus = i
				d.takeLocked(r, "digit")
				return 1
			}
		}
		d.log("ignored", map[string]any{"key": string(c)})
	case c == '\r':
		if d.focus < len(d.rows) {
			d.takeLocked(d.rows[d.focus], "enter")
		}
	}
	return 1
}

// takeLocked acts on a row: a box toggles, Submit answers with the boxes ticked, a text row opens the text line, "Chat about this" closes the dialog, and an option answers it.
func (d *dialogs) takeLocked(r dialogRow, by string) {
	switch {
	case r.boxed:
		d.checked[r.n] = !d.checked[r.n]
		d.log("toggle", map[string]any{"option": r.n, "label": r.label, "checked": d.checked[r.n], "by": by})
		d.eraseLocked()
		d.drawLocked()
	case r.role == "submit":
		var picked []string
		for _, row := range d.rows {
			if row.boxed && d.checked[row.n] {
				picked = append(picked, row.label)
			}
		}
		d.closeLocked("answer", map[string]any{"submit": picked, "by": by}, true)
	case r.role == "text":
		d.typing = true
		d.log("text_open", map[string]any{"option": r.n, "by": by})
		fmt.Print(" Type your answer, then Enter:\r\n")
		d.drawn++
	case r.role == "chat":
		d.closeLocked("answer", map[string]any{"option": r.n, "label": r.label, "chat": true, "by": by}, false)
	default:
		accepted := !strings.HasPrefix(strings.ToLower(r.label), "no") || kindOf(d.spec) == "question"
		d.closeLocked("answer", map[string]any{"option": r.n, "label": r.label, "by": by}, accepted)
	}
}

// closeLocked ends the dialog: it is cleared from the screen, the end is logged and said in one line, and the hook events of its end go (PostToolUse when the live call was answered, then Stop).
func (d *dialogs) closeLocked(event string, extra map[string]any, accepted bool) {
	d.log(event, extra)
	d.eraseLocked()
	if event == "dismiss" {
		fmt.Printf("[mock-agent] DIALOG %s dismissed\r\n", d.name)
	} else {
		fmt.Printf("[mock-agent] DIALOG %s ANSWERED %s\r\n", d.name, describeAnswer(extra))
	}
	tool := d.spec.toolOf()
	if accepted && tool != "" && hookOf(d.spec) == "live" {
		d.hook("PostToolUse", map[string]any{"tool_name": tool, "tool_use_id": d.toolID, "tool_response": map[string]any{"answer": extra}})
	}
	d.hook("Stop", map[string]any{"stop_hook_active": false})
	d.open, d.typing = false, false
	d.typed.Reset()
}

// describeAnswer says how a dialog was answered without its labels or text: Coral reads a menu as still drawn while its labels are on the screen
// (menuStillDrawn), so the line must not repeat them. The log has them.
func describeAnswer(extra map[string]any) string {
	switch {
	case extra["submit"] != nil:
		return fmt.Sprintf("by Submit, %d ticked", len(extra["submit"].([]string)))
	case extra["text"] != nil:
		return fmt.Sprintf("by text, %d bytes", len(extra["text"].(string)))
	}
	return fmt.Sprintf("option %v by %v", extra["option"], extra["by"])
}

// runStranger has another program draw the dialog: this executable again with --qa-stranger, holding the terminal until it ends (strangerAttr: on Unix it is the terminal's
// foreground job, as a shell starts one; on Windows a second program under the agent). The mock reads nothing meanwhile; its hook events for the spec go as for its own dialog.
func (d *dialogs) runStranger(name string, spec dialogSpec) {
	d.mu.Lock()
	d.seq++
	d.name, d.spec, d.toolID = name, spec, fmt.Sprintf("toolu_mock_d%d_%s", d.seq, short(d.session))
	tool := spec.toolOf()
	if tool != "" && hookOf(spec) == "live" {
		d.hook("PreToolUse", map[string]any{"tool_name": tool, "tool_use_id": d.toolID, "tool_input": spec.toolInput()})
		d.hook("PermissionRequest", map[string]any{"tool_name": tool, "tool_use_id": d.toolID, "tool_input": spec.toolInput()})
	}
	d.log("stranger_start", map[string]any{"kind": kindOf(spec), "hook": hookOf(spec)})
	d.mu.Unlock()
	exe, err := os.Executable()
	if err != nil {
		fmt.Printf("\r\n[mock-agent] stranger: %v\r\n", err)
		return
	}
	cmd := exec.Command(exe, "--qa-stranger", os.Getenv("MOCK_AGENT_DIALOGS"), name, d.logPath)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr = strangerAttr()
	fmt.Print("\r\n")
	runErr := cmd.Run()
	reclaimTerminal()
	d.mu.Lock()
	d.log("stranger_exit", map[string]any{"error": fmt.Sprint(runErr)})
	d.mu.Unlock()
	fmt.Printf("\r\n[mock-agent] the other program in the terminal ended (%v)\r\n", runErr)
}

// runStrangerChild is the program runStranger starts: it draws the dialog, logs every byte it is sent as "stranger_key", and answers nothing. It ends at an Escape or a Ctrl-C, or after
// the spec's StrangerSecs.
func runStrangerChild(specsFile, name, logPath string) int {
	specs, why := loadDialogSpecs(specsFile)
	spec, ok := specs[name]
	if !ok {
		fmt.Fprintf(os.Stderr, "[qa-stranger] %s: %s\n", name, why)
		return 2
	}
	d := &dialogs{logPath: logPath, name: name, spec: spec, rows: dialogRows(spec), checked: map[int]bool{}}
	if term.IsTerminal(int(os.Stdin.Fd())) {
		if old, err := term.MakeRaw(int(os.Stdin.Fd())); err == nil {
			defer term.Restore(int(os.Stdin.Fd()), old)
		}
	}
	d.drawLocked()
	secs := spec.StrangerSecs
	if secs <= 0 {
		secs = 60
	}
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 256)
		for {
			n, err := os.Stdin.Read(buf)
			for _, c := range buf[:n] {
				d.log("stranger_key", map[string]any{"key": string(c), "digit": c >= '0' && c <= '9', "pid": os.Getpid()})
				if c == 0x1b || c == 0x03 {
					close(done)
					return
				}
			}
			if err != nil {
				close(done)
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Duration(secs * float64(time.Second))):
	}
	d.eraseLocked()
	return 0
}
