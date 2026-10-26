// What is remembered per session: ended sessions and the last send skipped (#7727).

package ptymanager

import (
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/tmux"
)

// sessionOfTarget is the session a tmux target names: "claude-x", "claude-x.0",
// "claude-x:0" and "claude-x:0.0" are all claude-x (QA's #3431 v3 live check:
// the restart and launch paths pass pane targets).
func sessionOfTarget(target string) string {
	if i := strings.IndexByte(target, ':'); i >= 0 {
		target = target[:i]
	}
	return strings.TrimSuffix(target, ".0")
}

// sessionEndHooks clear what other packages remember per session (a log line already
// written for it, and the like) when ForgetSession ends that session's state, so those memos
// don't grow with every session the server has ever run (#4057).
var (
	sessionEndMu    sync.Mutex
	sessionEndHooks []func(name string)
)

// OnSessionEnd registers f to be called with a session's terminal name ("<type>-<id>")
// whenever its agent is killed, restarted, resumed or launched again (ForgetSession). Register
// once, at package init: hooks are never removed.
func OnSessionEnd(f func(name string)) {
	sessionEndMu.Lock()
	defer sessionEndMu.Unlock()
	sessionEndHooks = append(sessionEndHooks, f)
}

func forgetSessionMemos(name string) {
	tmux.ForgetBareNameWarning(name)
	sessionEndMu.Lock()
	hooks := append([]func(string){}, sessionEndHooks...)
	sessionEndMu.Unlock()
	for _, f := range hooks {
		f(name)
	}
}

// ForgetSession is called when a session's agent is killed, restarted, resumed or launched again: what Coral remembers of the old process
// (the text it typed last and the send it skipped) is not true of a new one.
func ForgetSession(name string) {
	name = sessionOfTarget(name)
	forgotten.notify(name)
	gate.mu.Lock()
	delete(gate.lastTyped, name)
	gate.mu.Unlock()
	skipped.Lock()
	delete(skipped.m, name)
	skipped.Unlock()
	forgetSessionMemos(name)
}

// SkippedSend is the last automated send Coral did not type into a session, and why (SkipPrompt, SkipDraft, ...): what the person sees
// beside the agent's unread board messages, which is all that waits for it.
type SkippedSend struct {
	Why  string    `json:"why"`
	What string    `json:"what"` // the sender ("board message", "task notification", ...); never the text
	At   time.Time `json:"at"`
	// Since is when this reason began: the first of the skips in a row with it.
	Since time.Time `json:"since"`
}

var skipped struct {
	sync.Mutex
	m map[string]SkippedSend
}

// SkippedOf returns the last send skipped for the session name, until a send is typed to it again (ok false: none).
func SkippedOf(name string) (SkippedSend, bool) {
	name = sessionOfTarget(name)
	skipped.Lock()
	defer skipped.Unlock()
	s, ok := skipped.m[name]
	return s, ok
}

func noteSkipped(in AutomatedInput, why string) {
	skipped.Lock()
	if skipped.m == nil {
		skipped.m = map[string]SkippedSend{}
	}
	since := gate.now()
	if prev, ok := skipped.m[in.Name]; ok && prev.Why == why {
		since = prev.Since // the same reason as the last skip: one streak, counted from its first
	}
	skipped.m[in.Name] = SkippedSend{Why: why, What: in.What, At: gate.now(), Since: since}
	skipped.Unlock()
	slog.Info("automated input: not typed", "session", in.Name, "sender", in.What, "why", why)
}

func clearSkipped(name string) {
	skipped.Lock()
	delete(skipped.m, name)
	skipped.Unlock()
}

// SkippedAtPrompt returns, by session name, since when automated input to that session has not been typed because a prompt or menu is
// open, for the health check's notice to the Operator (#4175 step 3). Only the time is given: nothing of the screen or of any text.
func SkippedAtPrompt() map[string]time.Time {
	return skippedSince(func(why string) bool { return strings.HasPrefix(why, SkipPrompt) })
}

// SkippedAtDraft is SkippedAtPrompt for text in the input box that Coral did not type (a person's draft, #247).
func SkippedAtDraft() map[string]time.Time {
	return skippedSince(func(why string) bool { return why == SkipDraft })
}

func skippedSince(match func(why string) bool) map[string]time.Time {
	skipped.Lock()
	defer skipped.Unlock()
	out := map[string]time.Time{}
	for name, s := range skipped.m {
		if match(s.Why) {
			out[name] = s.Since
		}
	}
	return out
}

// OnSessionForgotten registers f to be called with a session's terminal name when ForgetSession ends its state (the board notifier forgets what
// it nudged). It returns the function that removes it.
func OnSessionForgotten(f func(name string)) (stop func()) { return forgotten.add(f) }

var forgotten hookList

type hookList struct {
	mu   sync.Mutex
	next int
	fns  map[int]func(name string)
}

func (h *hookList) add(f func(name string)) func() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fns == nil {
		h.fns = map[int]func(string){}
	}
	id := h.next
	h.next++
	h.fns[id] = f
	return func() {
		h.mu.Lock()
		delete(h.fns, id)
		h.mu.Unlock()
	}
}

func (h *hookList) notify(name string) {
	h.mu.Lock()
	fns := make([]func(string), 0, len(h.fns))
	for _, f := range h.fns {
		fns = append(fns, f)
	}
	h.mu.Unlock()
	for _, f := range fns {
		f(name)
	}
}
