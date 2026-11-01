package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// Goal #14 (B), design #6550 with Security's #6548: an agent's single-select question is answered with its one clean "(Recommended)" option only when every condition holds.

// recQuestion is a Claude Code single-select question: the labels are the options' lines, each with a description line under it; a "Type something." and a "Chat about this" row follow.
func recQuestion(question string, labels ...string) string {
	var b strings.Builder
	b.WriteString("❯ Use the AskUserQuestion tool to ask me one single-select question.\n")
	b.WriteString("────────────────────────────────────────────────────────────────────\n")
	b.WriteString(" ☐ Choice\n")
	b.WriteString(question + "\n")
	n := 0
	for i, l := range labels {
		n = i + 1
		mark := "  "
		if i == 0 {
			mark = "❯ "
		}
		b.WriteString(mark + string(rune('0'+n)) + ". " + l + "\n")
		b.WriteString("     A description of the option\n")
	}
	b.WriteString("  " + string(rune('0'+n+1)) + ". Type something.\n")
	b.WriteString("────────────────────────────────────────────────────────────────────\n")
	b.WriteString("  " + string(rune('0'+n+2)) + ". Chat about this\n")
	b.WriteString("Enter to select · ↑/↓ to navigate · Esc to cancel\n")
	return b.String()
}

func recOf(t *testing.T, capture string) recommendation {
	t.Helper()
	return recommendedOption(parsedQuestion(t, capture), capture)
}

func parsedQuestion(t *testing.T, capture string) promptScreen {
	t.Helper()
	s, ok := parsePromptScreen(capture)
	require.True(t, ok, capture)
	return s
}

func TestRecommendedOptionPicksOneCleanLabel(t *testing.T) {
	good := recQuestion("Which color do you prefer?", "Red (Recommended)", "Green", "Blue")
	rec := recOf(t, good)
	assert.Empty(t, rec.Why)
	assert.Equal(t, 1, rec.N)
	assert.Equal(t, "Red (Recommended)", rec.Label)

	rec = recOf(t, recQuestion("Which color do you prefer?", "Red", "Green (Recommended)  ", "Blue"))
	assert.Empty(t, rec.Why)
	assert.Equal(t, 2, rec.N, "the digit is the option's own, wherever the mark is")
}

func TestRecommendedOptionRefusals(t *testing.T) {
	for name, capture := range map[string]string{
		"nothing marked":                  recQuestion("Which color?", "Red", "Green"),
		"two marked":                      recQuestion("Which color?", "Red (Recommended)", "Green (Recommended)"),
		"Other (Recommended)":             recQuestion("Which color?", "Red", "Other (Recommended)"),
		"lower case mark":                 recQuestion("Which color?", "Red (recommended)", "Green"),
		"one marked, one in lower case":   recQuestion("Which color?", "Red (Recommended)", "Green (recommended)"),
		"the mark in the middle":          recQuestion("Which color?", "Red (Recommended) please", "Green"),
		"bidi character in the label":     recQuestion("Which color?", "Re\u202ed (Recommended)", "Green"),
		"zero-width character in a label": recQuestion("Which color?", "Red (Recommended)", "Gr\u200ben"),
		"bidi character in the question":  recQuestion("Which\u2066 color?", "Red (Recommended)", "Green"),
		"homoglyph Recommended":           recQuestion("Which color?", "Red (Recommеnded)", "Green"), // a Cyrillic е
		"risk word in the question":       recQuestion("Delete the build folder?", "Yes (Recommended)", "No"),
		"risk word in a label":            recQuestion("Which step?", "Push to origin (Recommended)", "Wait"),
		"risk word, upper case":           recQuestion("Which step?", "Run with SUDO (Recommended)", "Wait"),
		"risk word: rm":                   recQuestion("Which step?", "rm the file (Recommended)", "Wait"),
	} {
		rec := recOf(t, capture)
		assert.NotEmpty(t, rec.Why, name)
		assert.Zero(t, rec.N, name)
	}
	// A word that merely contains a risk word is not one.
	rec := recOf(t, recQuestion("Which format for the formal report?", "Informal (Recommended)", "Terse"))
	assert.Empty(t, rec.Why, "informal and format hold 'rm' but not as a word: %s", rec.Why)
}

// QA's #422 fact (b): the parsed labels are cleaned of hidden characters, so the refusal reads the raw screen.
func TestRecommendedOptionRefusesAHiddenCharacterOnlyTheRawScreenHas(t *testing.T) {
	clean := recQuestion("Which color?", "Red (Recommended)", "Green")
	s := parsedQuestion(t, clean)
	assert.Empty(t, recommendedOption(s, clean).Why)
	for _, hidden := range []string{"\u200b", "\u202e", "\u2066", ""} {
		raw := strings.Replace(clean, "Red (Recommended)", "Re"+hidden+"d (Recommended)", 1)
		assert.NotEmpty(t, recommendedOption(s, raw).Why, "%q", hidden)
	}
}

func TestRecommendedOptionOnlyInTheDescriptionOrWrappedIsNotAPick(t *testing.T) {
	desc := strings.Replace(recQuestion("Which color?", "Red", "Green"), "A description of the option", "Red is the best fit (Recommended)", 1)
	assert.NotEmpty(t, recOf(t, desc).Why, "(Recommended) on a description line only")

	wrapped := "❯ ask\n────\n ☐ Choice\nWhich color?\n❯ 1. A long label that the terminal wraps over\n     two rows (Recommended)\n  2. Green\n  3. Type something.\n────\n  4. Chat about this\nEnter to select\n"
	s, ok := parsePromptScreen(wrapped)
	require.True(t, ok)
	assert.NotEmpty(t, recommendedOption(s, wrapped).Why, "a label that wraps over two rows: %+v", s.Options)
}

func TestRecommendedOptionNeverPicksPlanMultiOrReview(t *testing.T) {
	multi := promptScreen{Question: "Which?", Multi: true, Options: []promptOption{{N: 1, Label: "A (Recommended)", Action: "select"}, {N: 2, Label: "B", Action: "select"}}}
	assert.NotEmpty(t, recommendedOption(multi, "").Why)
	review := promptScreen{Question: "Which?", Review: []promptReviewItem{{Question: "q", Answer: "a"}}, Options: multi.Options}
	assert.NotEmpty(t, recommendedOption(review, "").Why)
	titled := promptScreen{Title: "Hooks need review", Question: "Which?", Options: multi.Options}
	assert.NotEmpty(t, recommendedOption(titled, "").Why)
	plan := promptScreen{Question: "Would you like to proceed?", Options: []promptOption{{N: 1, Label: "Yes, and auto-accept edits (Recommended)", Action: "select"}, {N: 2, Label: "No, keep planning", Action: "select"}}}
	plan.Options[0].Label = "Yes, and use auto mode (Recommended)"
	plan.Question = "Ready to code? Here is Claude's plan to publish"
	assert.NotEmpty(t, recommendedOption(plan, "").Why, "a question with a risk word")
	text := promptScreen{Question: "Which?", Options: []promptOption{{N: 1, Label: "Type something (Recommended)", Action: "text"}, {N: 2, Label: "B", Action: "select"}}}
	assert.NotEmpty(t, recommendedOption(text, "").Why, "a text option does not qualify")
	chat := promptScreen{Question: "Which?", Options: []promptOption{{N: 1, Label: "Chat about this (Recommended)", Action: "chat"}, {N: 2, Label: "B", Action: "select"}}}
	assert.NotEmpty(t, recommendedOption(chat, "").Why, "a chat option does not qualify")
	numbered := promptScreen{Question: "Which?", Unnumbered: true, Options: multi.Options}
	assert.NotEmpty(t, recommendedOption(numbered, "").Why, "no digits: arrows are not sent")
}

func TestTheNoticeIsFixedAndHasNoDigit(t *testing.T) {
	assert.Equal(t, "[Coral] The operator's setting chose the option you marked Recommended; the operator did not review this question.", autoRecommendNotice)
	for _, r := range autoRecommendNotice {
		assert.False(t, r >= '0' && r <= '9', "no digit in the notice: %q", r)
	}
	assert.NotContains(t, autoRecommendNotice, "%")
}

// --- through the dialog watch -----------------------------------------------------------------------------------------------------------------------------------------------------------

type recRig struct {
	h        *SessionsHandler
	term     *mockSessionTerminal
	rec      *AutoRecommender
	ctx      context.Context
	sid      string
	pane     string
	board    string
	t0       time.Time
	present  bool
	callID   string
	question string
	labels   []string // the screen's selectable options, as the record lists them
}

const recIdle = screenIdleList

// call is the PreToolUse record of a question call started at t0+at, carrying the rig's question and a description (as Claude's AskUserQuestion input does).
func (r *recRig) call(id, tool string, at time.Duration) pendingTool {
	return r.callAbout(id, tool, at, r.question)
}

// callAbout is call for another question; its options are labels (the rig's own when none are given), in the screen's order.
func (r *recRig) callAbout(id, tool string, at time.Duration, question string, labels ...string) pendingTool {
	if len(labels) == 0 {
		labels = r.labels
	}
	var opts []any
	for _, l := range labels {
		opts = append(opts, map[string]any{"label": l, "description": "A description of the option"})
	}
	return pendingTool{ToolUseID: id, ToolName: tool, At: r.t0.Add(at), Input: map[string]any{"questions": []any{map[string]any{"question": question, "options": opts}}}}
}

func newRecRig(t *testing.T, sidSuffix, capture string) *recRig {
	t.Helper()
	_, h, term, ss := setupSessionsTestServer(t)
	r := &recRig{h: h, term: term, ctx: context.Background(), sid: "00000000-0000-0000-0000-0000000e" + sidSuffix, board: "rec-team", t0: time.Date(2026, 10, 31, 6, 0, 0, 0, time.UTC), callID: "toolu_q1"}
	r.pane = "claude-" + r.sid
	bn := r.board
	require.NoError(t, ss.RegisterLiveSession(r.ctx, &store.LiveSession{SessionID: r.sid, AgentType: "claude", AgentName: r.pane, WorkingDir: "/tmp/test", BoardName: &bn}))
	term.addSession(r.pane, "/tmp/test")
	term.setOutput(r.pane, capture)
	hs := h.bs.GetHealthSettings(r.ctx, r.board)
	hs.AutoRecommend = board.HealthAutoRecommend{On: true, GraceMin: 3}
	require.NoError(t, h.bs.SetHealthSettings(r.ctx, r.board, hs))
	r.rec = NewAutoRecommender(h)
	r.question = parsedQuestion(t, capture).Question
	for _, o := range parsedQuestion(t, capture).Options {
		if o.Action == "select" {
			r.labels = append(r.labels, o.Label)
		}
	}
	h.pending.set(r.sid, r.call(r.callID, "AskUserQuestion", 0))
	// The pick clears the question; the notice then waits for the CLI's prompt.
	term.onRaw = func(string) { term.setOutput(r.pane, recIdle) }
	promptTextDelay = 0
	fastPromptChecks(t)
	return r
}

// passes runs dialog passes every 15 seconds for the given time from t0.
func (r *recRig) passes(d time.Duration) {
	for at := time.Duration(0); at <= d; at += 15 * time.Second {
		r.pass(at)
	}
	r.rec.notices.Wait()
}

// pass is one dialog pass at t0+at, with a dashboard view of the agent focused when r.present.
func (r *recRig) pass(at time.Duration) {
	if r.present {
		r.h.focus.note(r.sid, "view-1", true, r.t0.Add(at))
	}
	r.h.dialogPass(r.ctx, r.t0.Add(at))
}

func (r *recRig) raw() []string {
	r.term.mu.Lock()
	defer r.term.mu.Unlock()
	return append([]string(nil), r.term.raw[r.pane]...)
}

func (r *recRig) typed() []string {
	r.term.mu.Lock()
	defer r.term.mu.Unlock()
	return append([]string(nil), r.term.sent[r.pane]...)
}

func (r *recRig) events(t *testing.T) []store.AgentEvent {
	t.Helper()
	evs, err := r.h.ts.ListAgentEvents(r.ctx, r.pane, 50, nil)
	require.NoError(t, err)
	var out []store.AgentEvent
	for _, e := range evs {
		if e.EventType == "auto_recommend" {
			out = append(out, e)
		}
	}
	return out
}

func TestAutoRecommendHappyPath(t *testing.T) {
	r := newRecRig(t, "0001", recQuestion("Which color do you prefer?", "Red (Recommended)", "Green", "Blue"))
	r.passes(2 * time.Minute)
	assert.Empty(t, r.raw(), "inside the grace period nothing is sent")
	r.pass(3*time.Minute + 15*time.Second)
	r.rec.notices.Wait()
	assert.Equal(t, []string{"1"}, r.raw(), "the option's digit, once")
	assert.Equal(t, []string{autoRecommendNotice}, r.typed(), "then the fixed notice")
	evs := r.events(t)
	require.Len(t, evs, 1)
	assert.Contains(t, evs[0].Summary, "Red (Recommended)")

	r.pass(4 * time.Minute)
	assert.Equal(t, []string{"1"}, r.raw(), "nothing more")
}

func TestAutoRecommendIsOffByDefaultAndOnlyWhenSwitchedOn(t *testing.T) {
	r := newRecRig(t, "0002", recQuestion("Which color?", "Red (Recommended)", "Green"))
	assert.False(t, board.DefaultHealthSettings().AutoRecommend.On)
	assert.Equal(t, 3, board.DefaultHealthSettings().AutoRecommend.GraceMin)
	hs := r.h.bs.GetHealthSettings(r.ctx, r.board)
	hs.AutoRecommend.On = false
	require.NoError(t, r.h.bs.SetHealthSettings(r.ctx, r.board, hs))
	r.passes(10 * time.Minute)
	assert.Empty(t, r.raw())
	assert.Empty(t, r.typed())
}

func TestAutoRecommendWaitsForAPersonToBeAbsent(t *testing.T) {
	r := newRecRig(t, "0003", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.present = true
	r.passes(10 * time.Minute)
	assert.Empty(t, r.raw(), "a person is at the terminal")
	r.present = false
	r.h.focus.note(r.sid, "view-1", false, r.t0) // the view is blurred
	r.passes(10 * time.Minute)
	assert.Equal(t, []string{"1"}, r.raw(), "nobody there: picked")
}

func TestAutoRecommendNeedsTheLiveQuestionCall(t *testing.T) {
	// no call at all (a stale or missing record)
	r := newRecRig(t, "0004", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.h.pending.callDone(r.sid, r.callID)
	r.passes(10 * time.Minute)
	assert.Empty(t, r.raw(), "the call has a result: no live call")

	// a record of another tool is not a question
	r2 := newRecRig(t, "0005", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r2.h.pending.callDone(r2.sid, r2.callID)
	r2.h.pending.set(r2.sid, r2.call("toolu_bash", "Bash", 0))
	r2.passes(10 * time.Minute)
	assert.Empty(t, r2.raw(), "a Bash call is not a question call")

	// an old record is stale
	r3 := newRecRig(t, "0006", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r3.h.pending.callDone(r3.sid, r3.callID)
	r3.h.pending.set(r3.sid, r3.call("toolu_old", "AskUserQuestion", -2*time.Hour))
	r3.passes(10 * time.Minute)
	assert.Empty(t, r3.raw(), "a record older than the pending-tool limit")

	// two calls in flight: which one is on the screen is not known
	r4 := newRecRig(t, "0007", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r4.h.pending.set(r4.sid, r4.call("toolu_q2", "request_user_input", 0))
	r4.passes(10 * time.Minute)
	assert.Empty(t, r4.raw())
}

func TestAutoRecommendAChangedQuestionStartsTheGraceAgain(t *testing.T) {
	r := newRecRig(t, "0008", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.passes(2*time.Minute + 30*time.Second)
	r.term.setOutput(r.pane, recQuestion("Which shape?", "Round (Recommended)", "Square"))
	r.h.pending.set(r.sid, r.callAbout(r.callID, "AskUserQuestion", 0, "Which shape?", "Round (Recommended)", "Square"))
	r.pass(3*time.Minute + 15*time.Second)
	r.pass(3*time.Minute + 30*time.Second)
	assert.Empty(t, r.raw(), "another ask: the wait starts over")
	r.pass(6*time.Minute + 45*time.Second)
	r.rec.notices.Wait()
	assert.Equal(t, []string{"1"}, r.raw())
}

func TestAutoRecommendNeverTypesAtAProgramThatIsNotTheCLI(t *testing.T) {
	r := newRecRig(t, "0009", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.h.terminal = noticeGateRig{mockSessionTerminal: r.term, why: "the terminal's foreground program is not the agent"}
	r.passes(10 * time.Minute)
	assert.Empty(t, r.raw(), "the gate would hold the notice: no pick")
	assert.Empty(t, r.typed(), "and nothing typed")
}

// noticeGateRig is the mock terminal whose foreground program is not the agent (or is, when ok).
type noticeGateRig struct {
	*mockSessionTerminal
	ok   bool
	wait bool // the agent process is still being recorded: the gate waits
	why  string
}

func (n noticeGateRig) AgentShellIdle(context.Context, string, string, string) (bool, string, bool) {
	return false, "claude", true
}

func (n noticeGateRig) AgentNoticeTarget(context.Context, string, string, string) (bool, bool, string, bool) {
	return n.ok, n.wait, n.why, true
}

func TestAutoRecommendCaps(t *testing.T) {
	// the same ask twice
	r := newRecRig(t, "000a", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.passes(4 * time.Minute)
	require.Equal(t, []string{"1"}, r.raw())
	r.term.setOutput(r.pane, recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.h.pending.set(r.sid, r.call("toolu_q9", "AskUserQuestion", 5*time.Minute))
	for at := 5 * time.Minute; at <= 12*time.Minute; at += 15 * time.Second {
		r.pass(at)
	}
	r.rec.notices.Wait()
	assert.Equal(t, []string{"1"}, r.raw(), "the same ask is never answered twice")

	// 3 an hour per agent: four different questions, the fourth waits for the hour
	r2 := newRecRig(t, "000b", recQuestion("Question 1?", "Red (Recommended)", "Green"))
	at := time.Duration(0)
	for i := 1; i <= 4; i++ {
		r2.h.pending.callDone(r2.sid, r2.callID)
		r2.callID = "toolu_" + string(rune('a'+i))
		qn := "Question " + string(rune('0'+i)) + " or not?"
		r2.h.pending.set(r2.sid, r2.callAbout(r2.callID, "AskUserQuestion", at, qn, "Red (Recommended)", "Green"))
		r2.term.setOutput(r2.pane, recQuestion(qn, "Red (Recommended)", "Green"))
		for end := at + 4*time.Minute; at <= end; at += 15 * time.Second {
			r2.pass(at)
		}
		r2.rec.notices.Wait()
	}
	assert.Len(t, r2.raw(), autoRecommendPerAgent, "3 an hour for one agent")
}

func TestAutoRecommendTeamCap(t *testing.T) {
	r := newRecRig(t, "000c", recQuestion("Question 0?", "Red (Recommended)", "Green"))
	// six picks already counted for other agents of the team in this hour
	for i := 0; i < autoRecommendPerTeam; i++ {
		r.rec.note("other-"+string(rune('a'+i)), r.board, "ask", r.t0)
	}
	r.passes(10 * time.Minute)
	assert.Empty(t, r.raw(), "6 an hour for the team")
	// the hour passes
	r.pass(70 * time.Minute)
	r.pass(70*time.Minute + 15*time.Second)
	r.h.pending.set(r.sid, r.call(r.callID, "AskUserQuestion", 70*time.Minute))
	for at := 71 * time.Minute; at <= 76*time.Minute; at += 15 * time.Second {
		r.pass(at)
	}
	r.rec.notices.Wait()
	assert.Equal(t, []string{"1"}, r.raw(), "a pick is allowed again once the hour has passed")
}

func TestAutoRecommendSettingIsClamped(t *testing.T) {
	hs := board.DefaultHealthSettings()
	hs.AutoRecommend.GraceMin = 0
	assert.Equal(t, 3, hs.Clamp().AutoRecommend.GraceMin, "a body that does not carry it: the default")
	hs.AutoRecommend.GraceMin = 500
	assert.Equal(t, board.AutoRecommendGraceMax, hs.Clamp().AutoRecommend.GraceMin, "under the dialog timeout's own minimum")
	hs.AutoRecommend.GraceMin = -4
	assert.Equal(t, 1, hs.Clamp().AutoRecommend.GraceMin)
}

// The switch is the operator's: an agent's token is refused (403), it is off until the operator turns it on, and the grace is kept in range.
func TestAutoRecommendSettingIsOperatorOnlyAndOffByDefault(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-a", nil, "all")
	require.NoError(t, err)
	require.False(t, h.bs.GetHealthSettings(ctx, "team").AutoRecommend.On, "off by default")
	put := func(mod func(*http.Request), grace ...int) int {
		g := 4
		if len(grace) > 0 {
			g = grace[0]
		}
		body := fmt.Sprintf(`{"subscriber_id":"Operator","health":{"on":true,"auto_recommend":{"on":true,"grace_min":%d}}}`, g)
		req := httptest.NewRequest(http.MethodPut, "/api/board/team/settings", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		mod(req)
		rec := httptest.NewRecorder()
		h.UpdateBoardSettings(rec, req)
		return rec.Code
	}
	assert.Equal(t, http.StatusForbidden, put(func(r *http.Request) {
		*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-a"}))
	}), "an agent token")
	assert.Equal(t, http.StatusForbidden, put(func(r *http.Request) { r.Header.Set("User-Agent", "coral-board/1.0") }), "the agent command line")
	assert.False(t, h.bs.GetHealthSettings(ctx, "team").AutoRecommend.On, "still off")
	assert.Equal(t, http.StatusOK, put(func(r *http.Request) { r.Header.Set("User-Agent", "Mozilla/5.0") }), "the dashboard")
	got := h.bs.GetHealthSettings(ctx, "team").AutoRecommend
	assert.True(t, got.On)
	assert.Equal(t, 4, got.GraceMin)
	// Out of range is refused with a 400, as the dialog timeout's wait is, and nothing is saved.
	dash := func(r *http.Request) { r.Header.Set("User-Agent", "Mozilla/5.0") }
	assert.Equal(t, http.StatusBadRequest, put(dash, 99), "over the maximum")
	assert.Equal(t, http.StatusBadRequest, put(dash, -2), "under the minimum")
	assert.Equal(t, 4, h.bs.GetHealthSettings(ctx, "team").AutoRecommend.GraceMin, "unchanged")
}

// QA's #422 finding: the ConPTY capture drops zero-width characters, so a label the record itself carries with one is refused.
func TestRecordLabelsWithAHiddenCharacterAreRefused(t *testing.T) {
	r := newRecRig(t, "0014", recQuestion("Which color?", "Red (Recommended)", "Green"))
	tool := r.call(r.callID, "AskUserQuestion", 0)
	tool.Input["questions"].([]any)[0].(map[string]any)["options"] = []any{map[string]any{"label": "Re\u200bd (Recommended)", "description": "x"}}
	r.h.pending.set(r.sid, tool)
	r.passes(10 * time.Minute)
	assert.Empty(t, r.raw(), "the screen is clean (the capture dropped it) but the record's label is not")
	assert.True(t, hiddenIn(map[string]any{"a": []any{"x\u202ey"}}))
	assert.False(t, hiddenIn(map[string]any{"a": []any{"line one\nline two"}}), "a newline in a description is not hidden")
}

func TestCapLabelMakesAnAgentWrittenLabelSafeForAnEvent(t *testing.T) {
	assert.Equal(t, "a b", capLabel("a\n\tb"))
	assert.LessOrEqual(t, len(capLabel(strings.Repeat("é", 500))), autoRecommendLabelMax+len("…"), "the cap, and the ellipsis it adds")
	assert.True(t, utf8.ValidString(capLabel(strings.Repeat("é", 500))), "cut on a character")
	assert.Equal(t, "x", capLabel("x\xff"))
}

// Security's #6773 SHOULD 2: the brake reads every option's description line too, not only the labels.
func TestRecommendedOptionRefusesARiskWordInADescription(t *testing.T) {
	clean := recQuestion("Which color?", "Red (Recommended)", "Green")
	s := parsedQuestion(t, clean)
	assert.Empty(t, recommendedOption(s, clean).Why)
	for _, d := range []string{"Drops the table", "Pushes to main", "Uses the SUDO account"} {
		raw := strings.Replace(clean, "A description of the option", d, 1)
		assert.NotEmpty(t, recommendedOption(parsedQuestion(t, raw), raw).Why, d)
		raw2 := strings.Replace(clean, "A description of the option", "fine", 1)
		raw2 = strings.Replace(raw2, "A description of the option", d, 1) // the other option's description
		assert.NotEmpty(t, recommendedOption(parsedQuestion(t, raw2), raw2).Why, "second option: "+d)
	}
}

// Security's INFO a: the live call's own record must carry the question on the screen, and its descriptions are judged whole.
func TestRecordMustCarryTheQuestionOnTheScreen(t *testing.T) {
	assert.True(t, recordMatches(`[{"question":"Which color do you prefer?","options":[]}]`, "Which color do you prefer?"))
	assert.False(t, recordMatches("", "Which color?"), "a record that kept no questions cannot be compared")
	assert.False(t, recordMatches(`[{"question":"Which shape?"}]`, "Which color?"), "another question")
	assert.False(t, recordMatches(`[{"question":"Which color?","options":[{"description":"Drops the table"}]}]`, "Which color?"), "a risk word in a description the screen may not show")

	r := newRecRig(t, "0010", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.h.pending.set(r.sid, r.callAbout(r.callID, "AskUserQuestion", 0, "A completely different question"))
	r.passes(10 * time.Minute)
	assert.Empty(t, r.raw(), "the screen shows a question the call did not ask")
}

// Security's #6773 SHOULD 1: the same pre-check as the dialog timeout (notices paused, a person's send in flight, a draft at the last skip).
func TestAutoRecommendPicksNothingWhenTheNoticeWouldBeHeld(t *testing.T) {
	r := newRecRig(t, "0011", recQuestion("Which color?", "Red (Recommended)", "Green"))
	ptymanager.PauseNotices(r.sid, time.Hour)
	r.passes(10 * time.Minute)
	assert.Empty(t, r.raw(), "notices are paused for this agent: no pick")
	assert.Empty(t, r.typed())
}

// A notice that is not typed after a pick is an agent event and the team line says so.
func TestAutoRecommendSaysWhenTheAgentWasNotTold(t *testing.T) {
	r := newRecRig(t, "0012", recQuestion("Which color?", "Red (Recommended)", "Green"))
	// the moment the pick is sent the terminal stops being the agent's foreground program, so the gate refuses the notice
	r.term.onRaw = func(string) {
		r.term.setOutput(r.pane, recIdle)
		r.h.terminal = noticeGateRig{mockSessionTerminal: r.term, why: "the terminal's foreground program is not the agent"}
	}
	r.passes(4 * time.Minute)
	require.Equal(t, []string{"1"}, r.raw())
	var told bool
	for _, e := range r.allEvents(t) {
		told = told || e.EventType == "auto_recommend_notice_not_typed"
	}
	assert.True(t, told, "the agent event")
	res, err := r.h.bs.QueryMessages(r.ctx, &board.MessageQuery{Project: r.board, Limit: 20})
	require.NoError(t, err)
	var line string
	for _, m := range res.Messages {
		if strings.Contains(m.Content, "NOT told") {
			line = m.Content
		}
	}
	assert.Contains(t, line, "auto_recommend_notice_not_typed")
}

func (r *recRig) allEvents(t *testing.T) []store.AgentEvent {
	t.Helper()
	evs, err := r.h.ts.ListAgentEvents(r.ctx, r.pane, 50, nil)
	require.NoError(t, err)
	return evs
}

// Security's #6787: the event and the team line that say the agent was not told have a deadline of their own, so they still go out when the notice waited until its deadline.
func TestAutoRecommendSaysItEvenWhenTheNoticeRanOutOfTime(t *testing.T) {
	old := autoRecommendNoticeWait
	autoRecommendNoticeWait = 150 * time.Millisecond
	t.Cleanup(func() { autoRecommendNoticeWait = old })
	r := newRecRig(t, "0013", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.term.onRaw = func(string) {
		r.term.setOutput(r.pane, recIdle)
		r.h.terminal = noticeGateRig{mockSessionTerminal: r.term, wait: true, why: "starting"} // the gate waits until the notice's deadline
	}
	start := time.Now()
	r.passes(4 * time.Minute)
	assert.Less(t, time.Since(start), 5*time.Second)
	require.Equal(t, []string{"1"}, r.raw())
	var event bool
	for _, e := range r.allEvents(t) {
		event = event || e.EventType == "auto_recommend_notice_not_typed"
	}
	assert.True(t, event, "the agent event, although the notice's own deadline had passed")
	res, err := r.h.bs.QueryMessages(r.ctx, &board.MessageQuery{Project: r.board, Limit: 20})
	require.NoError(t, err)
	var line string
	for _, m := range res.Messages {
		if strings.Contains(m.Content, "NOT told") {
			line = m.Content
		}
	}
	assert.NotEmpty(t, line, "and the team line")
}

// Security's ruling on QA's U+200B finding: the pick is bound to the record's own option list: the n-th option of the record's question must be the picked label, "(Recommended)" included.
func TestRecordMustListThePickedLabelAtThePickedPosition(t *testing.T) {
	for name, labels := range map[string][]string{
		"the mark is on another option":      {"Red", "Green (Recommended)"},
		"the label differs":                  {"Crimson (Recommended)", "Green"},
		"the mark is missing":                {"Red", "Green"},
		"fewer options than the pick's slot": {},
	} {
		r := newRecRig(t, "0015", recQuestion("Which color?", "Red (Recommended)", "Green"))
		if len(labels) == 0 {
			r.h.pending.set(r.sid, pendingTool{ToolUseID: r.callID, ToolName: "AskUserQuestion", At: r.t0, Input: map[string]any{"questions": []any{map[string]any{"question": r.question}}}})
		} else {
			r.h.pending.set(r.sid, r.callAbout(r.callID, "AskUserQuestion", 0, r.question, labels...))
		}
		r.passes(10 * time.Minute)
		assert.Empty(t, r.raw(), name)
	}
	assert.True(t, newRecRig(t, "0016", recQuestion("Which color?", "Red (Recommended)", "Green")).h.recordHasOption(
		"00000000-0000-0000-0000-0000000e0016", time.Date(2026, 10, 31, 6, 0, 0, 0, time.UTC), "Which color?", 1, "Red (Recommended)"))
}
