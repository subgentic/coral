package routes

import (
	"context"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// Auto-accept of the recommended decision (goal #14 (B), design #6550 with Security's #6548).
//
// An agent asks a single-select question and marks one option "(Recommended)". When the operator has turned this on for the team, the question has waited the grace period with nobody at the
// terminal, and everything below holds, Coral answers with that option's digit and then types one fixed line to the agent, so its own log never reads as if a person answered.
//
// The agent wrote the label, so this is the agent answering its own question. What bounds it:
//   - the pick is bound to the LIVE question call: a PreToolUse record of an allow-listed question tool with no result yet, matched to the ask on the screen and unchanged since the grace began;
//     the pane's foreground is the CLI (the notice gate's test); all of it re-checked inside the agent's lock (agent_lock.go) just before the key;
//   - the fixed notice is mandatory: if the gate would hold it, nothing is picked;
//   - a brake on questions that ask for consent to something irreversible or outward (autoRecommendRisk): a brake, not a boundary, since re-wording gets past it;
//   - the label is matched strictly (recommendedOption);
//   - at most autoRecommendPerAgent picks per agent and autoRecommendPerTeam per team per hour, and never twice on one ask.
//
// A question this does not answer stays for the person, and for the dialog timeout after it.

// autoRecommendNotice is the line typed after a pick: fixed, no variable, no digit (Security's #6538 point 1).
const autoRecommendNotice = "[Coral] The operator's setting chose the option you marked Recommended; the operator did not review this question."

const (
	autoRecommendPerAgent = 3
	autoRecommendPerTeam  = 6
	autoRecommendWindow   = time.Hour
	autoRecommendPasses   = 2 // the same bound question seen in this many passes before it is picked
	// autoRecommendNoticeWait bounds how long the notice waits for the CLI's input prompt after a pick.
	autoRecommendNoticeWait = 90 * time.Second
	autoRecommendLabelMax   = 120 // the label an event carries
)

// autoRecommendTools are the tools whose call is a question to the person; nothing else binds a pick.
var autoRecommendTools = []string{"AskUserQuestion", "request_user_input", "ask_question"}

// autoRecommendRisk is the brake: a question or label with one of these as a whole word is not answered.
var autoRecommendRisk = regexp.MustCompile(`(?i)\b(delete|force|overwrite|deploy|production|push|publish|send|pay|credentials|token|secret|sudo|rm)\b`)

const recommendedSuffix = "(Recommended)"

// recommendation is what recommendedOption finds on a screen: the option to pick, or why none.
type recommendation struct {
	N     int
	Label string // the label as shown, with its suffix
	Why   string // set when there is no pick
}

// recommendedOption decides, from the screen (parsed, and its text) alone, whether a question has one clean Recommended option. It never judges the live call, the gate or the caps (autoRecommend does).
func recommendedOption(s promptScreen, text string) recommendation {
	no := func(why string) recommendation { return recommendation{Why: why} }
	switch {
	case s.Title != "":
		return no("a titled dialog is not an agent's question")
	case s.Multi || s.Submit != nil:
		return no("a multi-select question")
	case len(s.Review) > 0:
		return no("a review step")
	case s.Unnumbered:
		return no("its options carry no digits")
	case s.OnlyReject:
		return no("a request that only rejects")
	case strings.TrimSpace(s.Question) == "" || len(s.Options) < 2:
		return no("no question or fewer than two options")
	}
	if hiddenChar(text) { // the raw screen: the parsed labels the API serves are cleaned of hidden characters, so only the text still has them
		return no("a hidden character on the screen")
	}
	if hiddenChar(s.Question) {
		return no("a hidden character in the question")
	}
	if autoRecommendRisk.MatchString(s.Question) {
		return no("the question holds a risk word")
	}
	pick := -1
	mentions := 0
	for i, o := range s.Options {
		if o.Wrapped && rowMayWrap(text, o) { // Wrapped is also set by an option's description line: only a first row that fills the width can be a label that continues
			return no("a label may wrap over two rows")
		}
		if hiddenChar(o.Label) {
			return no("a hidden character in a label")
		}
		if autoRecommendRisk.MatchString(o.Label) {
			return no("a label holds a risk word")
		}
		label := strings.TrimSpace(o.Label)
		if strings.Contains(strings.ToLower(label), "(recommended)") {
			mentions++
		}
		if !strings.HasSuffix(label, recommendedSuffix) {
			continue
		}
		name := strings.TrimSpace(strings.TrimSuffix(label, recommendedSuffix))
		switch {
		case o.Action != "select":
			continue // a text or chat option
		case strings.EqualFold(name, "other") || name == "":
			continue // "Other (Recommended)" is the agent's own way out, not its recommendation
		case o.N < 1 || o.N > 9:
			continue
		}
		if pick >= 0 {
			return no("two options are marked Recommended")
		}
		pick = i
	}
	if mentions > 1 {
		return no("more than one label says Recommended")
	}
	if pick < 0 {
		return no("no option is marked Recommended")
	}
	o := s.Options[pick]
	return recommendation{N: o.N, Label: strings.TrimSpace(o.Label)}
}

// rowMayWrap reports whether the option's first row reaches the terminal's width, so that the line under it may be the rest of its label and not a description. The width is read from the
// dialog's own rule lines; a screen with none, or a row that cannot be found, is taken as wrapping.
func rowMayWrap(text string, o promptOption) bool {
	width, row := 0, -1
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		l = strings.TrimRight(l, " ")
		if separatorRe.MatchString(l) {
			width = max(width, utf8.RuneCountInString(strings.TrimSpace(l)))
			continue
		}
		if m := promptOptionRe.FindStringSubmatch(l); m != nil && m[2] == strconv.Itoa(o.N) && strings.TrimSpace(m[3]) == strings.TrimSpace(o.Label) {
			row = utf8.RuneCountInString(l)
		}
	}
	return width == 0 || row < 0 || row >= width-8
}

// hiddenChar reports a Unicode format (Cf: bidi, zero-width) or control (Cc) character.
func hiddenChar(s string) bool {
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' {
			continue
		}
		if unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Cc, r) {
			return true
		}
	}
	return false
}

// recBound is a question Coral is waiting out: the ask and the live call it is bound to, since when, and in how many passes.
type recBound struct {
	ask, call string
	since     time.Time
	passes    int
}

// AutoRecommender holds what the picks remember: the question each agent is waited on, the picks made (for the caps) and the asks already picked.
type AutoRecommender struct {
	h   *SessionsHandler
	now func() time.Time

	mu     sync.Mutex
	bound  map[string]recBound            // session -> the question being waited out
	agent  map[string][]time.Time         // session -> pick times in the window
	team   map[string][]time.Time         // board -> pick times in the window
	picked map[string]map[string]struct{} // session -> asks already picked

	notices sync.WaitGroup // the notices being typed (tests wait for them)
}

// NewAutoRecommender creates the engine for a sessions handler.
func NewAutoRecommender(h *SessionsHandler) *AutoRecommender {
	r := &AutoRecommender{
		h: h, now: time.Now,
		bound:  map[string]recBound{},
		agent:  map[string][]time.Time{},
		team:   map[string][]time.Time{},
		picked: map[string]map[string]struct{}{},
	}
	h.autoRecommend = r
	return r
}

// keepOnly drops what is remembered of sessions that are no longer awake.
func (r *AutoRecommender) keepOnly(live map[string]bool) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for sid := range r.bound {
		if !live[sid] {
			delete(r.bound, sid)
		}
	}
	for sid := range r.agent {
		if !live[sid] {
			delete(r.agent, sid)
		}
	}
	for sid := range r.picked {
		if !live[sid] {
			delete(r.picked, sid)
		}
	}
}

// liveQuestionCall is the one question call of the session that has started and not finished (the PreToolUse record), or "" when there is none or more than one.
func (h *SessionsHandler) liveQuestionCall(sessionID string, now time.Time) string {
	var ids []string
	for _, tool := range autoRecommendTools {
		ids = append(ids, h.pending.callsFor(sessionID, tool, now, pendingToolTTL, "")...)
	}
	if len(ids) != 1 {
		return ""
	}
	return ids[0]
}

// withinWindow keeps the times that are still inside the cap window.
func withinWindow(ts []time.Time, now time.Time) []time.Time {
	out := ts[:0:0]
	for _, t := range ts {
		if now.Sub(t) < autoRecommendWindow {
			out = append(out, t)
		}
	}
	return out
}

// capped reports whether a pick for this agent and team would pass a cap, or the ask was picked before.
func (r *AutoRecommender) capped(sid, project, ask string, now time.Time) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, done := r.picked[sid][ask]; done {
		return "this question was answered once already", true
	}
	r.agent[sid] = withinWindow(r.agent[sid], now)
	r.team[project] = withinWindow(r.team[project], now)
	if len(r.agent[sid]) >= autoRecommendPerAgent {
		return "this agent has had its picks for the hour", true
	}
	if len(r.team[project]) >= autoRecommendPerTeam {
		return "this team has had its picks for the hour", true
	}
	return "", false
}

// note counts a pick, at the moment its key is sent: a failed send is not tried again for the same ask.
func (r *AutoRecommender) note(sid, project, ask string, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.agent[sid] = append(withinWindow(r.agent[sid], now), now)
	r.team[project] = append(withinWindow(r.team[project], now), now)
	if r.picked[sid] == nil {
		r.picked[sid] = map[string]struct{}{}
	}
	if len(r.picked[sid]) >= 64 { // an agent that asks that many different questions: forget the oldest by starting over; the caps above still hold
		r.picked[sid] = map[string]struct{}{}
	}
	r.picked[sid][ask] = struct{}{}
}

// bind records the question seen this pass and reports how long it has been the same one and in how many passes. A different ask or call starts again.
func (r *AutoRecommender) bind(sid, ask, call string, now time.Time) recBound {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.bound[sid]
	if !ok || b.ask != ask || b.call != call {
		b = recBound{ask: ask, call: call, since: now}
	}
	b.passes++
	r.bound[sid] = b
	return b
}

func (r *AutoRecommender) unbind(sid string) {
	r.mu.Lock()
	delete(r.bound, sid)
	r.mu.Unlock()
}

// pass is one look at one awake agent's screen from the dialog watch. shown is whether a prompt is on it.
func (r *AutoRecommender) pass(ctx context.Context, a liveAgent, screen promptScreen, shown bool, now time.Time) {
	if r == nil || r.h == nil || r.h.bs == nil || a.board == "" {
		return
	}
	hs := r.h.bs.GetHealthSettings(ctx, a.board).AutoRecommend
	if !hs.On || !shown {
		r.unbind(a.sid)
		return
	}
	_, _, text, err := r.h.readPromptScreenText(ctx, a.name, a.agentType, a.sid)
	rec := recommendedOption(screen, text)
	if err != nil || rec.Why != "" || screen.AskID == "" {
		r.unbind(a.sid)
		return
	}
	call := r.h.liveQuestionCall(a.sid, now)
	if call == "" {
		r.unbind(a.sid)
		return
	}
	b := r.bind(a.sid, screen.AskID, call, now)
	if b.passes < autoRecommendPasses || now.Sub(b.since) < time.Duration(hs.GraceMin)*time.Minute {
		return
	}
	r.pick(ctx, a, b, now)
}

// pick re-checks everything inside the agent's lock and, if it all still holds, sends the digit, then the notice.
func (r *AutoRecommender) pick(ctx context.Context, a liveAgent, b recBound, now time.Time) {
	h := r.h
	pane := naming.SessionName(a.agentType, a.sid) // the session's own terminal, as auto-accept names it
	if h.personPresent(a.sid, now) {               // a person typed there or has its terminal view focused (dialog_timeout.go)
		return
	}
	if _, capped := r.capped(a.sid, a.board, b.ask, now); capped {
		return
	}
	unlock, ok := h.tryLockAgent(a.sid)
	if !ok {
		return
	}
	defer unlock()

	// Everything is read again inside the lock: the screen, the ask, the live call, the setting, the gate.
	if !h.bs.GetHealthSettings(ctx, a.board).AutoRecommend.On {
		return
	}
	screen, shown, text, err := h.readPromptScreenText(ctx, a.name, a.agentType, a.sid)
	if err != nil || !shown || screen.AskID != b.ask {
		return
	}
	rec := recommendedOption(screen, text)
	if rec.Why != "" || rec.N < 1 || rec.N > len(screen.Options) || screen.Options[rec.N-1].N != rec.N {
		return
	}
	if h.liveQuestionCall(a.sid, now) != b.call {
		return
	}
	if h.personPresent(a.sid, now) {
		return
	}
	// The notice is part of the contract: if the gate would hold it (the CLI is not the foreground program, a shell, a terminal agent), nothing is picked.
	if automatedInputBlocked(ctx, h.terminal, pane, a.agentType, a.sid, "recommended-pick notice") {
		return
	}
	if _, capped := r.capped(a.sid, a.board, b.ask, now); capped {
		return
	}

	r.note(a.sid, a.board, b.ask, now)
	sentAt := r.now().Add(-time.Microsecond).UTC().Format(store.ISOFormat)
	if err := ptymanager.AutoAcceptSend(ctx, pane, func(ctx context.Context) error {
		return h.terminal.SendRawInput(ctx, terminalinput.Internal, pane, []string{strconv.Itoa(rec.N)}, a.agentType, a.sid)
	}); err != nil {
		slog.Warn("auto-recommend: sending the pick failed", "session", a.sid, "error", err)
		return
	}
	r.unbind(a.sid)
	h.forgetDialog(a.sid)

	label := capLabel(rec.Label)
	recordAutoAcceptEventAt(ctx, h.ts, a.name, a.sid, "auto_recommend", "Answered the question with the option marked Recommended: "+label, "", map[string]any{
		"agent_type": a.agentType, "option": label, "n": rec.N,
	}, sentAt)
	who := "An agent"
	if ls, err := h.ss.GetLiveSession(ctx, a.sid); err == nil && ls != nil && ls.DisplayName != nil {
		who = noticeName(*ls.DisplayName, nil) // cleaned: capped, no @
	}
	if _, err := h.bs.PostSystemMessage(ctx, a.board, board.CoralSender, "[Coral] "+who+"'s question was answered with the option it marked Recommended (the operator's setting; nobody was at the terminal).", nil); err != nil {
		slog.Warn("auto-recommend: the team line failed", "board", a.board, "error", err)
	}
	h.kickWS()

	// The notice is typed through the normal gate once the question is gone; not under the lock, and bounded.
	r.notices.Add(1)
	go func() {
		defer r.notices.Done()
		nctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), autoRecommendNoticeWait)
		defer cancel()
		if err := deliverAutomated(nctx, h.terminal, pane, a.agentType, a.sid, autoRecommendNotice, "recommended-pick notice"); err != nil {
			slog.Warn("auto-recommend: the notice was not typed", "session", a.sid, "error", err)
		}
	}()
}

// capLabel is an agent-written label made safe for an event: valid UTF-8, one line, at most autoRecommendLabelMax bytes.
func capLabel(s string) string {
	s = strings.Join(strings.Fields(strings.ToValidUTF8(s, "")), " ")
	return truncateUTF8(s, autoRecommendLabelMax)
}
