package ptymanager

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// Automated input (#3431, rebuilt for #7727).
//
// Coral types automated text into agents: board notifications and nudges, task notifications, message-wait results, the remote poller,
// a launch's first prompt, agent UI notices. There is no queue and no waiting: DeliverAutomated looks at the agent's screen once and
// then either types the text with its Enter, at once, or does not type it. Whatever the agent is doing is the CLI's business: a
// harness queues what is typed in the middle of a turn, so a turn, a background shell or monitor in the footer, or a stale state in
// Coral's hooks is never a reason to wait. The hooks are not read at all.
//
// It does not type when typing would be a wrong answer to something the person has to decide, which the screen shows:
//   - a prompt or menu is open (a permission prompt, a selection list, a trust or update dialog, an approval, an open slash menu):
//     the text and its Enter would answer it, and Enter takes the highlighted option, which is "Yes" in Claude's permission prompt;
//   - the input box holds text Coral did not type last (a person's draft): the nudge would be added to it and sent with it;
//   - the screen cannot be read, or is empty.
//
// Nothing that is not typed is kept: for a board nudge the unread message stays on the board and the next nudge says it again. A
// readable screen that matches none of the above gets the text, recognised or not.
//
// Explicit human input never goes through here: the operator typing in the terminal or the dashboard, and a person picking a
// prompt option (prompt_answer.go). The opt-in auto-accept feature answers approval prompts on purpose and uses the AutoAcceptSend
// exemption, which nothing else may use.

// Delivery says what DeliverAutomated did with a send.
type Delivery int

const (
	// Sent: the text was typed now.
	Sent Delivery = iota
	// Skipped: nothing was typed: a prompt or menu is open, the input box holds text of a person's, or the screen could not be read.
	// Nothing is kept for later.
	Skipped
)

func (d Delivery) String() string {
	if d == Skipped {
		return "skipped"
	}
	return "sent"
}

// AutomatedInput is one automated send.
type AutomatedInput struct {
	// Term is the terminal or runtime the text goes to, read for the screen (ScreenReader).
	Term any
	// Name, AgentType and SessionID identify the agent's session.
	Name, AgentType, SessionID string
	// Text is what will be typed, for the input debug log.
	Text string
	// What names the sender in logs ("board message", "initial prompt", ...).
	What string
	// Send types the text.
	Send func(ctx context.Context) error
	// RequireInputBox waits for the agent's normal input box to be on screen first (see waits(): launchWait), instead of looking once:
	// a launch's first prompt, which a still-drawing trust or login screen could otherwise take as its answer, and which nothing would
	// repeat. The only wait there is.
	RequireInputBox bool
	// Paste sends Text as one bracketed paste and then Enter where the agent's terminal can (PromptSender, with bracketed paste on),
	// so a menu that opens just before it ignores it instead of taking it as an answer (#3457); Send is then the fallback, for a
	// terminal or agent without bracketed paste. Ready, when set, runs just before (the caller's has-the-agent-exited check).
	Paste bool
	Ready func(ctx context.Context) error
	// force: a person's own Send now (DeliverNow): the screen being unreadable is not a reason to skip.
	force bool
}

// EnterSender is implemented by terminals that can press Enter in an agent's terminal: Coral's own earlier text left in the input
// box is submitted with it.
type EnterSender interface {
	SendEnter(ctx context.Context, name, agentType, sessionID string) error
}

// ArrowSender is implemented by terminals that can press Up or Down in an agent's terminal: what moves the
// selection of a menu whose options carry no numbers (Claude Code's folder-trust and API-key menus, #4543).
type ArrowSender interface {
	SendArrow(ctx context.Context, name, agentType, sessionID string, up bool) error
}

// ScreenReader is implemented by terminals that can show an agent's visible
// screen (the bottom of its tmux pane, or its PTY output).
type ScreenReader interface {
	AgentScreen(ctx context.Context, name, agentType, sessionID string) (string, error)
}

// typedMemo is the last text Coral typed to a session, squeezed, and whether it went as a paste: what an input box holding exactly
// that is taken to be Coral's own.
type typedMemo struct {
	text  string
	paste bool
	at    time.Time // when Coral typed it: a paste placeholder is Coral's own only for a short while after
	blind bool      // it went to an agent whose box Coral cannot read: nothing says it was taken (#11165)
}

type inputGate struct {
	mu sync.Mutex
	// sending serialises the sends to one session, so two nudges are not interleaved in one box.
	sending sync.Map // session name -> *sync.Mutex
	// lastTyped: each session's last text Coral typed, until the agent's box is seen empty or the session ends.
	lastTyped map[string]typedMemo
	nowFn     atomic.Pointer[func() time.Time] // the clock; nil is time.Now. Tests replace it
}

var gate = &inputGate{lastTyped: map[string]typedMemo{}}

// now is the gate's clock.
func (g *inputGate) now() time.Time {
	if f := g.nowFn.Load(); f != nil {
		return (*f)()
	}
	return time.Now()
}

func (g *inputGate) lockSession(name string) func() {
	m, _ := g.sending.LoadOrStore(name, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// noteTyped records the text just typed to name (what a box holding exactly it is later taken to be).
func (g *inputGate) noteTyped(name, text string, paste bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.lastTyped[name] = typedMemo{text: squeeze(text), paste: paste, at: g.now()}
}

// markBlind notes that the text just typed to name went to a box that cannot be read.
func (g *inputGate) markBlind(name string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if m, ok := g.lastTyped[name]; ok {
		m.blind = true
		g.lastTyped[name] = m
	}
}

func (g *inputGate) typedFor(name string) (typedMemo, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	m, ok := g.lastTyped[name]
	return m, ok
}

func (g *inputGate) forgetTyped(name string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.lastTyped, name)
}
