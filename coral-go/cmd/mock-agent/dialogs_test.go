package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/vtscreen"
)

// dialogSpecs are the specs the tests open, written to a MOCK_AGENT_DIALOGS file.
var dialogSpecs = map[string]dialogSpec{
	"pick":   {Header: "Color", Question: "Which color do you prefer?", Options: []dialogOption{{"Red (Recommended)", "A warm, bold color"}, {"Blue", "A cool, calm color"}}},
	"multi":  {Header: "Fruit", Question: "Which fruits?", Multi: true, Options: []dialogOption{{"Apple (Recommended)", ""}, {"Pear", ""}}},
	"perm":   {Kind: "permission", Context: []string{"rm -rf build", "Remove the build folder"}},
	"plan":   {Kind: "plan", Context: []string{"Plan: create hello.txt", "1. Create it.", "2. Verify it."}},
	"review": {Kind: "review", Header: "Fruit", Context: []string{" ● Which fruits?", "   → Apple"}},
	"stale":  {Hook: "stale", Header: "Color", Question: "Stale?", Options: []dialogOption{{"Yes (Recommended)", ""}, {"No", ""}}},
	"long":   {Header: "Long", Question: "Wrapped?", NoExtras: true, Options: []dialogOption{{strings.Repeat("word ", 30) + "(Recommended)", ""}, {"Short", ""}}},
	"first":  {Header: "Color", Question: "First ask?", ChangeAfter: 0.05, ChangeTo: "second", Options: []dialogOption{{"Red (Recommended)", ""}, {"Blue", ""}}},
	"second": {Header: "Color", Question: "Second ask?", Options: []dialogOption{{"Green (Recommended)", ""}, {"Blue", ""}}},
	"later":  {Header: "Color", Question: "Later?", OpenAfter: 0.05, Options: []dialogOption{{"Red", ""}, {"Blue", ""}}},
	"closes": {Header: "Color", Question: "Closes by itself?", CloseAfter: 0.05, Options: []dialogOption{{"Red", ""}, {"Blue", ""}}},
}

// A dialog with close_after_s closes by itself as an Escape would: Stop, no PostToolUse.
func TestDialogClosesByItself(t *testing.T) {
	d, hooks, _ := newTestDialogs(t)
	captureOut(t, func() {
		d.start("closes")
		time.Sleep(300 * time.Millisecond)
	})
	if d.isOpen() {
		t.Fatal("the dialog is still open")
	}
	if got := events(*hooks); got != "PreToolUse,PermissionRequest,Stop" {
		t.Errorf("hook events %s", got)
	}
}

type firedHook struct {
	event string
	extra map[string]any
}

// newTestDialogs is a dialogs with the test specs, a log in a temp folder and the hook events recorded.
func newTestDialogs(t *testing.T) (*dialogs, *[]firedHook, string) {
	t.Helper()
	dir := t.TempDir()
	specs, _ := json.Marshal(dialogSpecs)
	file := filepath.Join(dir, "dialogs.json")
	if err := os.WriteFile(file, specs, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOCK_AGENT_DIALOGS", file)
	// hooksMu: the timers fire hook events while a test reads them
	var hooks []firedHook
	d := newDialogs(dir, "sess-1234-5678", func(e string, x map[string]any) {
		hooksMu.Lock()
		hooks = append(hooks, firedHook{e, x})
		hooksMu.Unlock()
	})
	term := &lockedBuf{}
	d.out = term
	terms.Store(t, term)
	t.Cleanup(func() { terms.Delete(t) })
	return d, &hooks, filepath.Join(dir, "sess-1234-5678.dialog.jsonl")
}

// lockedBuf is a terminal the dialogs' timers may write to while a test reads it.
type lockedBuf struct {
	mu sync.Mutex
	b  []byte
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.b = append(l.b, p...)
	return len(p), nil
}

func (l *lockedBuf) take() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.b
	l.b = nil
	return out
}

// terms holds each test dialogs' terminal.
var terms sync.Map

// captureOut runs f and returns what the dialogs wrote meanwhile (all of them write to their own terminal, newTestDialogs's), and what went to
// os.Stdout (the input box's own lines), in that order.
func captureOut(t *testing.T, f func()) []byte {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = w
	got := make(chan []byte)
	go func() { b, _ := io.ReadAll(r); got <- b }()
	f()
	os.Stdout = stdout
	w.Close()
	box := <-got
	var dl []byte
	terms.Range(func(k, v any) bool {
		if k.(*testing.T) == t {
			dl = v.(*lockedBuf).take()
		}
		return true
	})
	return append(dl, box...)
}

func feedAll(d *dialogs, keys string) {
	data := []byte(keys)
	for i := 0; i < len(data); {
		n := d.feed(data[i:])
		if n == 0 {
			return
		}
		i += n
	}
}

func readDialogLog(t *testing.T, path string) []map[string]any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []map[string]any
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

var hooksMu sync.Mutex

func events(hooks []firedHook) string {
	hooksMu.Lock()
	defer hooksMu.Unlock()
	var s []string
	for _, h := range hooks {
		s = append(s, h.event)
	}
	return strings.Join(s, ",")
}

// Every kind is drawn as a prompt Coral sees on the screen, and the question keeps its "(Recommended)" label on the label line.
func TestDialogKindsAreDrawnAsPromptsCoralSees(t *testing.T) {
	for _, name := range []string{"pick", "multi", "perm", "plan", "review"} {
		t.Run(name, func(t *testing.T) {
			d, _, _ := newTestDialogs(t)
			out := captureOut(t, func() {
				if !d.start(name) {
					t.Fatal("the dialog did not open")
				}
			})
			screen := vtscreen.Render(out, 100, 30)
			if p, _ := ptymanager.PromptOnScreen(screen); !p {
				t.Errorf("Coral does not see the dialog on the screen:\n%s", screen)
			}
			if name == "pick" && !strings.Contains(screen, "❯ 1. Red (Recommended)\n     A warm, bold color") {
				t.Errorf("the label and its description are not drawn as Claude Code draws them:\n%s", screen)
			}
		})
	}
}

// A digit answers the live call: PreToolUse and PermissionRequest at the opening, PostToolUse and Stop at the answer, all with one tool_use_id; the key is logged as a digit, and the
// dialog is gone from the screen.
func TestDialogDigitAnswersTheLiveCall(t *testing.T) {
	d, hooks, logPath := newTestDialogs(t)
	out := captureOut(t, func() {
		d.start("pick")
		feedAll(d, "2")
	})
	if got := events(*hooks); got != "PreToolUse,PermissionRequest,PostToolUse,Stop" {
		t.Fatalf("hook events %s", got)
	}
	id := (*hooks)[0].extra["tool_use_id"]
	if (*hooks)[2].extra["tool_use_id"] != id || id == "" {
		t.Errorf("the answer names another call: %v vs %v", (*hooks)[2].extra["tool_use_id"], id)
	}
	if d.isOpen() {
		t.Error("the dialog is still open")
	}
	log := readDialogLog(t, logPath)
	var digit, answer bool
	for _, e := range log {
		digit = digit || (e["event"] == "key" && e["digit"] == true && e["key"] == "2")
		answer = answer || (e["event"] == "answer" && e["label"] == "Blue")
	}
	if !digit || !answer {
		t.Errorf("the log misses the digit or the answer: %v", log)
	}
	screen := vtscreen.Render(out, 100, 30)
	if p, _ := ptymanager.PromptOnScreen(screen); p || !strings.Contains(screen, "ANSWERED option 2 by digit") {
		t.Errorf("after the answer the screen still shows a prompt or no answer line:\n%s", screen)
	}
}

// A stale record: the finished call's PreToolUse and PostToolUse come before the dialog, and its answer has no PostToolUse of its own.
func TestDialogStaleRecord(t *testing.T) {
	d, hooks, _ := newTestDialogs(t)
	captureOut(t, func() {
		d.start("stale")
		feedAll(d, "1")
	})
	if got := events(*hooks); got != "PreToolUse,PostToolUse,Stop" {
		t.Fatalf("hook events %s", got)
	}
	if id, _ := (*hooks)[0].extra["tool_use_id"].(string); !strings.HasSuffix(id, "_stale") {
		t.Errorf("the record is not the stale call's: %q", id)
	}
}

// An Escape dismisses: no PostToolUse; a permission's "No" is no approval either.
func TestDialogEscapeAndNo(t *testing.T) {
	d, hooks, _ := newTestDialogs(t)
	captureOut(t, func() {
		d.start("perm")
		feedAll(d, "\x1b")
		d.start("perm")
		feedAll(d, "3")
	})
	if got := events(*hooks); got != "PreToolUse,PermissionRequest,Notification,Stop,PreToolUse,PermissionRequest,Notification,Stop" {
		t.Errorf("hook events %s", got)
	}
}

// A multi-select question: digits toggle the boxes and answer nothing; Down to the Submit row and Enter answers with the ticked labels.
func TestDialogMultiSelect(t *testing.T) {
	d, _, logPath := newTestDialogs(t)
	captureOut(t, func() {
		d.start("multi")
		feedAll(d, "12")
		if !d.isOpen() {
			t.Fatal("a digit answered a multi-select question")
		}
		feedAll(d, "2\x1b[B\x1b[B\r") // from Pear, past "Type something" to Submit
	})
	if d.isOpen() {
		t.Fatal("Submit did not answer")
	}
	log := readDialogLog(t, logPath)
	last := log[len(log)-1]
	if last["event"] != "answer" || strings.Join(toStrings(last["submit"]), ",") != "Apple (Recommended)" {
		t.Errorf("the answer is %v", last)
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

// A label longer than the row wraps onto a row indented five, as Claude Code's own layout wraps it.
func TestDialogLongLabelWraps(t *testing.T) {
	d, _, _ := newTestDialogs(t)
	d.spec, d.rows = dialogSpecs["long"], dialogRows(dialogSpecs["long"])
	lines := d.render(60)
	var at int
	for i, l := range lines {
		if strings.HasPrefix(l, "❯ 1. word") {
			at = i
		}
	}
	if at == 0 || !strings.HasPrefix(lines[at+1], "     word") {
		t.Errorf("the label does not wrap onto an indented row:\n%s", strings.Join(lines, "\n"))
	}
	for _, l := range lines {
		if n := len([]rune(l)); n >= 60 {
			t.Errorf("a row of %d runes would be wrapped by the terminal: %q", n, l)
		}
	}
}

// A dialog that changes while open is redrawn as another ask with the same call; one that opens later leaves the box's draft alone and opens with a line of its own.
func TestDialogChangeAndOpenLater(t *testing.T) {
	d, hooks, logPath := newTestDialogs(t)
	out := captureOut(t, func() {
		d.start("first")
		time.Sleep(300 * time.Millisecond)
	})
	if !strings.Contains(vtscreen.Render(out, 100, 30), "Second ask?") || strings.Contains(vtscreen.Render(out, 100, 30), "First ask?") {
		t.Errorf("the dialog was not redrawn as the second ask:\n%s", vtscreen.Render(out, 100, 30))
	}
	if got := events(*hooks); got != "PreToolUse,PermissionRequest" {
		t.Errorf("a change fired hook events of its own: %s", got)
	}
	captureOut(t, func() { feedAll(d, "\x1b") })

	captureOut(t, func() {
		if !d.start("later") || d.isOpen() {
			t.Fatal("the dialog opened at once, or is not coming")
		}
		time.Sleep(300 * time.Millisecond)
	})
	if !d.isOpen() {
		t.Fatal("the late dialog did not open")
	}
	var change, late bool
	for _, e := range readDialogLog(t, logPath) {
		change = change || (e["event"] == "change" && e["to"] == "second")
		late = late || (e["event"] == "open" && e["late"] == true)
	}
	if !change || !late {
		t.Error("the log misses the change or the late opening")
	}
}

// An unknown name or a second dialog opens nothing.
func TestDialogRefusesUnknownAndSecond(t *testing.T) {
	d, _, _ := newTestDialogs(t)
	out := captureOut(t, func() {
		if d.start("nope") {
			t.Error("an unknown dialog opened")
		}
		d.start("pick")
		if d.start("perm") {
			t.Error("a second dialog opened over the first")
		}
	})
	if !strings.Contains(string(out), `MOCK_DIALOG "nope": no such dialog`) {
		t.Errorf("no word on the unknown name:\n%s", out)
	}
}

// The input box hands its keys to an open dialog and gets them back once it closes.
func TestInputBoxHandsKeysToTheDialog(t *testing.T) {
	d, _, _ := newTestDialogs(t)
	var got []string
	b := &inputBox{dlg: d}
	captureOut(t, func() {
		b.feed([]byte("MOCK_DIALOG pick\r"), func(s string) {
			got = append(got, s)
			applyControl(b, s)
		})
		b.feed([]byte("1hello\r"), func(s string) { got = append(got, s) })
	})
	if strings.Join(got, "|") != "MOCK_DIALOG pick|hello" {
		t.Errorf("submissions %q: the digit went to the box, or the box did not get its keys back", got)
	}
}

// A session name that is not one path element gets no dialog record, so the record never lands outside the raw folder.
func TestDialogRecordNeedsASafeSessionName(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MOCK_AGENT_DIALOGS", "")
	for _, name := range []string{"../out", `..\out`, "a/b", "..", ""} {
		if d := newDialogs(dir, name, func(string, map[string]any) {}); d.logPath != "" {
			t.Errorf("session %q: dialog record at %q, want none", name, d.logPath)
		}
	}
	if d := newDialogs(dir, "sess-1234-5678", func(string, map[string]any) {}); d.logPath != filepath.Join(dir, "sess-1234-5678.dialog.jsonl") {
		t.Errorf("a plain session id: dialog record at %q", d.logPath)
	}
}
