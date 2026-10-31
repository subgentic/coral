package ptymanager

// Pausing Coral's notices to one agent (#11387; the operator: "User is talking to orchestrator, but screen keeps advancing due to notifications from Coral"). Two reasons hold Coral's own automated text
// back from an agent's terminal, and neither drops it:
//  1. the person paused it (PauseNotices: until they resume, or a cap), and
//  2. the person typed to that agent within the last TypingHold (terminalinput.PersonTypedWithin): no toggle for the common case.
//
// A held notice is NOT typed and is counted, by what it was (a board message, a task, ...), never by its text. When the hold ends (the person resumes, the cap passes, or they stop typing for TypingHold)
// ONE short line is typed instead of the many: "[Coral] While you were talking: 3 board messages, 1 task. Run coral-board read." The person's own typing and sends are never held (DeliverNow), nor are an
// agent's first prompt or a script's own /send, which are not notices. The line is typed through DeliverAutomated like any notice, so every rule of it applies (an exited agent's shell, a recorded process
// only, a prompt or draft on the screen, a person's send in flight).

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/terminalinput"
)

const (
	// DefaultNoticePause is how long a pause lasts when no length is given: a forgotten pause does not silence an agent for ever.
	DefaultNoticePause = 30 * time.Minute
	// MaxNoticePause is the longest a pause may be asked to last.
	MaxNoticePause = 12 * time.Hour
	// TypingHold is how long after the person's last keystroke to an agent Coral's notices to it wait.
	TypingHold = 60 * time.Second
	// heldKeepFor is how long held notices wait for a moment they can be told: past it they are forgotten (the agent is gone, or never free).
	heldKeepFor = 15 * time.Minute
	// heldWhat is the sender name of the line that stands for the held notices.
	heldWhat = "held notices"
	// maxHeldDistinct is how many distinct notices of one sender are remembered by hash for one session; past it they are only counted.
	maxHeldDistinct = 1000
)

// The seams of the hold, atomic because the timers read them while a test sets them (the census of seams_census_test.go): the clock, the typing window and what types the summary.
var (
	noticeClock  atomic.Pointer[func() time.Time]
	typingWindow atomic.Int64 // nanoseconds; 0: TypingHold
	summarySend  atomic.Pointer[func(ctx context.Context, tmpl AutomatedInput, text string) error]
)

func noticeNow() time.Time {
	if f := noticeClock.Load(); f != nil {
		return (*f)()
	}
	return time.Now()
}

func typingHold() time.Duration {
	if n := typingWindow.Load(); n > 0 {
		return time.Duration(n)
	}
	return TypingHold
}

// typeSummary types the summary line into the agent's terminal.
func typeSummary(ctx context.Context, tmpl AutomatedInput, text string) error {
	if f := summarySend.Load(); f != nil {
		return (*f)(ctx, tmpl, text)
	}
	term, ok := tmpl.Term.(SessionTerminal)
	if !ok {
		return errors.New("no terminal to type the held notices into")
	}
	return term.SendInput(ctx, terminalinput.Coral, tmpl.Name, text, tmpl.AgentType, tmpl.SessionID)
}

// notHeld are the senders the hold never touches: an agent's first prompt (a launch is not a notice), the line that stands for the held ones, and an auto-accept answer (a pause is for Coral's notices, never for approvals: an agent on a permission prompt must not wait up to 12 hours).
func notHeld(what string) bool {
	return what == "initial prompt" || what == heldWhat || what == "auto-accept answer" || strings.HasPrefix(what, "automated ")
}

type noticeState struct {
	until     time.Time                      // an explicit pause ends here (zero: not paused)
	latest    map[string]int                 // sender -> the largest "You have N unread" a held board nudge said: a nudge states a count, so that count is what is told, never the number of nudges
	toldBoard bool                           // a summary that stood for held board nudges was typed: the notifier does not nudge the same messages again
	extra     map[string]int                 // sender -> notices past maxHeldDistinct, counted and not remembered
	held      map[string]map[uint64]struct{} // sender -> the distinct notices held (by hash of their text: a notice asked again is one)
	since     time.Time                      // when the first notice was held
	tmpl      AutomatedInput                 // where and how the summary is typed: the terminal, the names, the sender's own checks
	flusher   bool                           // a flush of this session is running
	timer     *time.Timer                    // the next look at whether the hold has ended (none while nothing is held)
}

var notices = struct {
	sync.Mutex
	m map[string]*noticeState
}{m: map[string]*noticeState{}}

func stateOf(sessionID string) *noticeState {
	st := notices.m[sessionID]
	if st == nil {
		st = &noticeState{held: map[string]map[uint64]struct{}{}, extra: map[string]int{}, latest: map[string]int{}}
		notices.m[sessionID] = st
	}
	return st
}

// PauseNotices holds Coral's notices to the session for d (DefaultNoticePause when d is not positive, at most MaxNoticePause) and says until when.
func PauseNotices(sessionID string, d time.Duration) time.Time {
	if sessionID == "" {
		return time.Time{}
	}
	if d <= 0 {
		d = DefaultNoticePause
	}
	if d > MaxNoticePause {
		d = MaxNoticePause
	}
	notices.Lock()
	defer notices.Unlock()
	st := stateOf(sessionID)
	st.until = noticeNow().Add(d)
	return st.until
}

// ResumeNotices ends a pause. What was held is told once, now when the agent is free, else as soon as it is.
func ResumeNotices(sessionID string) {
	notices.Lock()
	if st := notices.m[sessionID]; st != nil {
		st.until = time.Time{}
	}
	notices.Unlock()
	time.AfterFunc(0, func() { flushHeld(sessionID) })
}

// NoticeStatus is what the live row shows: whether an explicit pause is on and until when, how many notices wait, and whether the hold is only the person's typing.
func NoticeStatus(sessionID string) (paused bool, until time.Time, waiting int, typing bool) {
	notices.Lock()
	defer notices.Unlock()
	now := noticeNow()
	if st := notices.m[sessionID]; st != nil {
		if st.until.After(now) {
			paused, until = true, st.until
		}
		for _, n := range heldCounts(st.held, st.extra, st.latest) {
			waiting += n
		}
	}
	typing = !paused && terminalinput.PersonTypedWithin(sessionID, typingHold())
	return
}

// NoticesHeld reports whether Coral's notices to the session are held now (a pause, or the person typing to it): the turn-end hand-off, which is a hook reply and not a typed notice, waits too.
func NoticesHeld(sessionID string) bool { return noticesHeld(sessionID) }

// noticesHeld reports whether Coral's notices to the session are held now: paused, or the person typed to it within TypingHold.
func noticesHeld(sessionID string) bool {
	if sessionID == "" {
		return false
	}
	notices.Lock()
	st := notices.m[sessionID]
	paused := st != nil && st.until.After(noticeNow())
	notices.Unlock()
	return paused || terminalinput.PersonTypedWithin(sessionID, typingHold())
}

// holdNotice counts a notice that was not typed, by what it was, and keeps where the summary will be typed.
func holdNotice(in AutomatedInput) {
	h := fnv.New64a()
	h.Write([]byte(in.Text))
	notices.Lock()
	defer notices.Unlock()
	st := stateOf(in.SessionID)
	if !st.since.IsZero() && noticeNow().Sub(st.since) > heldKeepFor { // forgotten here too, not only at a flush: a pause for hours does not grow without end
		st.held, st.extra, st.latest, st.since = map[string]map[uint64]struct{}{}, map[string]int{}, map[string]int{}, time.Time{}
	}
	if n, ok := nudgeCount(in); ok { // a board nudge states how many messages are unread: keep the largest
		if n > st.latest[in.What] {
			st.latest[in.What] = n
		}
		if st.since.IsZero() {
			st.since = noticeNow()
		}
		st.tmpl = AutomatedInput{Term: in.Term, Name: in.Name, AgentType: in.AgentType, SessionID: in.SessionID, Ready: in.Ready}
		scheduleFlushLocked(in.SessionID, st, 3*time.Second)
		return
	}
	set := st.held[in.What]
	if set == nil {
		set = map[uint64]struct{}{}
		st.held[in.What] = set
	}
	if _, seen := set[h.Sum64()]; !seen {
		if len(set) < maxHeldDistinct {
			set[h.Sum64()] = struct{}{}
		} else {
			st.extra[in.What]++
		}
	}
	if st.since.IsZero() {
		st.since = noticeNow()
	}
	st.tmpl = AutomatedInput{Term: in.Term, Name: in.Name, AgentType: in.AgentType, SessionID: in.SessionID, Ready: in.Ready}
	scheduleFlushLocked(in.SessionID, st, 3*time.Second)
}

// scheduleFlushLocked arranges a look at whether the hold has ended, in d (notices.Lock held). A timer, not a goroutine that lives on: nothing runs while nothing is held.
func scheduleFlushLocked(sessionID string, st *noticeState, d time.Duration) {
	if st.timer != nil {
		st.timer.Stop()
	}
	st.timer = time.AfterFunc(d, func() { flushHeld(sessionID) })
}

// boardNudgeWhat is the sender of the notifier's "You have N unread messages" nudge.
const boardNudgeWhat = "board nudge"

var nudgeCountRe = regexp.MustCompile(`^You have (\d{1,9}) unread messages? on the message board`)

// nudgeCount is the unread count a board nudge states (ok false for any other notice).
func nudgeCount(in AutomatedInput) (int, bool) {
	if in.What != boardNudgeWhat {
		return 0, false
	}
	m := nudgeCountRe.FindStringSubmatch(in.Text)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	return n, err == nil && n > 0
}

// NoteBoardNudgeTold is the flush's own mark, exported so the notifier's tests can stand in for a typed summary.
func NoteBoardNudgeTold(sessionID string) {
	notices.Lock()
	defer notices.Unlock()
	stateOf(sessionID).toldBoard = true
}

// TakeBoardNudgeTold reports, once, that a summary which stood for held board nudges was typed for the session: the notifier then takes those messages as told and does not nudge them again (one line, not two).
func TakeBoardNudgeTold(sessionID string) bool {
	notices.Lock()
	defer notices.Unlock()
	if st := notices.m[sessionID]; st != nil && st.toldBoard {
		st.toldBoard = false
		return true
	}
	return false
}

// noticeLabels turn a sender into the words the summary uses.
var noticeLabels = map[string][2]string{
	"board message":      {"board message", "board messages"},
	"board nudge":        {"board message", "board messages"},
	"remote board nudge": {"board message", "board messages"},
	"task notification":  {"task", "tasks"},
	"task reminder":      {"task", "tasks"},
	"board wait timeout": {"board wait", "board waits"},
	"health check":       {"health check", "health checks"},
	"health nudge":       {"health check", "health checks"},
	"agent UI action":    {"request from a panel", "requests from a panel"},
}

// heldCounts is how many notices each sender held: the remembered ones and those counted past the cap.
func heldCounts(held map[string]map[uint64]struct{}, extra, latest map[string]int) map[string]int {
	out := map[string]int{}
	for what, n := range latest {
		out[what] += n
	}
	for what, set := range held {
		out[what] += len(set) + extra[what]
	}
	for what, n := range extra {
		if _, ok := held[what]; !ok {
			out[what] += n
		}
	}
	return out
}

// heldSummary is the one line: "[Coral] While you were talking: 3 board messages, 1 task. Run coral-board read." Counts and fixed words only: nothing a notice said.
func heldSummary(held map[string]int) string {
	counts := map[string]int{}
	order := []string{}
	for what, n := range held {
		singular, plural := "notice", "notices"
		if l, ok := noticeLabels[what]; ok {
			singular, plural = l[0], l[1]
		}
		key := singular + "|" + plural
		if _, seen := counts[key]; !seen {
			order = append(order, key)
		}
		counts[key] += n
	}
	sort.Strings(order)
	parts := make([]string, 0, len(order))
	for _, key := range order {
		singular, plural, _ := strings.Cut(key, "|")
		word := plural
		if counts[key] == 1 {
			word = singular
		}
		parts = append(parts, fmt.Sprintf("%d %s", counts[key], word))
	}
	return "[Coral] While you were talking: " + strings.Join(parts, ", ") + ". Run coral-board read."
}

// flushHeld types the one line for what a session held, if its hold has ended and the agent can take it; otherwise leaves it for the next pass. Held notices older than heldKeepFor are forgotten.
func flushHeld(sessionID string) {
	if noticesHeld(sessionID) {
		notices.Lock()
		if st := notices.m[sessionID]; st != nil && (len(st.held) > 0 || len(st.extra) > 0 || len(st.latest) > 0) {
			scheduleFlushLocked(sessionID, st, 3*time.Second) // still held: look again soon
		}
		notices.Unlock()
		return
	}
	notices.Lock()
	st := notices.m[sessionID]
	if st == nil || (len(st.held) == 0 && len(st.extra) == 0 && len(st.latest) == 0) || st.flusher {
		notices.Unlock()
		return
	}
	if !st.since.IsZero() && noticeNow().Sub(st.since) > heldKeepFor {
		st.held, st.extra, st.latest, st.since = map[string]map[uint64]struct{}{}, map[string]int{}, map[string]int{}, time.Time{}
		notices.Unlock()
		return
	}
	st.flusher = true
	text, tmpl := heldSummary(heldCounts(st.held, st.extra, st.latest)), st.tmpl
	taken, takenExtra := map[string][]uint64{}, map[string]int{} // a snapshot: what is held while the line is typed stays held
	for what, set := range st.held {
		for k := range set {
			taken[what] = append(taken[what], k)
		}
	}
	for what, n := range st.extra {
		takenExtra[what] = n
	}
	takenLatest := map[string]int{}
	for what, n := range st.latest {
		takenLatest[what] = n
	}
	notices.Unlock()

	done, sent := false, false
	defer func() {
		notices.Lock()
		if cur := notices.m[sessionID]; cur != nil {
			cur.flusher = false
			if !done && (len(cur.held) > 0 || len(cur.extra) > 0 || len(cur.latest) > 0) { // the agent could not take it yet (a prompt, a draft): look again
				scheduleFlushLocked(sessionID, cur, 3*time.Second)
			}
			if done { // what was told is gone; what was held in the meantime stays
				for what, keys := range taken {
					for _, k := range keys {
						delete(cur.held[what], k)
					}
					if len(cur.held[what]) == 0 {
						delete(cur.held, what)
					}
				}
				for what, n := range takenExtra {
					if cur.extra[what] -= n; cur.extra[what] <= 0 {
						delete(cur.extra, what)
					}
				}
				for what, n := range takenLatest {
					if cur.latest[what] == n { // a bigger count that arrived while the line was typed stays
						delete(cur.latest, what)
					}
				}
				if sent && takenLatest[boardNudgeWhat] > 0 {
					cur.toldBoard = true
				}
				if len(cur.held) == 0 && len(cur.extra) == 0 && len(cur.latest) == 0 {
					cur.since = time.Time{}
				}
			}
		}
		notices.Unlock()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	d, err := DeliverAutomated(ctx, AutomatedInput{
		Term: tmpl.Term, Name: tmpl.Name, AgentType: tmpl.AgentType, SessionID: tmpl.SessionID,
		Text: text, What: heldWhat, Paste: true, Ready: tmpl.Ready,
		Send: func(ctx context.Context) error {
			if tmpl.Ready != nil {
				if err := tmpl.Ready(ctx); err != nil {
					return err
				}
			}
			return typeSummary(ctx, tmpl, text)
		},
	})
	sent = err == nil && d == Sent
	if err != nil || d == Sent { // typed, or an error that no later try mends (the agent exited): either way it is over
		done = true
	}
}

// forgetNotices drops a session's pause and what it held when the session ends.
func forgetNotices(name string) {
	if id := naming.SessionIDFromName(sessionOfTarget(name)); id != "" {
		notices.Lock()
		if st := notices.m[id]; st != nil && st.timer != nil {
			st.timer.Stop()
		}
		delete(notices.m, id)
		notices.Unlock()
	}
}
