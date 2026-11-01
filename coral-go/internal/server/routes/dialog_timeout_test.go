package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/opencode"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// The dialog timeout (goal #14, #6543 with Security's #6540): closes a dialog nobody answered, the safe way, and types the fixed notice; never when a person is there, the gate would hold
// the notice, the prompt changed, or the CLI and kind have no mapped close.

// claudeScreen is a captured Claude Code 2.1.300 screen, without its colours.
func claudeScreen(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile("../../ptymanager/testdata/screens/claude/2.1.300/" + file + ".ansi")
	require.NoError(t, err)
	return ansiSGR.ReplaceAllString(string(b), "")
}

type timeoutRig struct {
	t      *testing.T
	h      *SessionsHandler
	term   *agentTerm
	mock   *mockSessionTerminal
	sid    string
	name   string
	agent  liveAgent
	t0     time.Time
	idle   string
	onKeys func(keys []string) // what the screen does after the close's keys; default: the CLI's input box
}

var timeoutRigN atomic.Int64

// newTimeoutRig is a Claude agent (its own session id: a person's typing is remembered per id, process-wide) showing screen, waiting on a request of kind, seen by the dialog watch for
// two passes from t0.
func newTimeoutRig(t *testing.T, agentType, kind, screen string) *timeoutRig {
	t.Helper()
	_, h, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := fmt.Sprintf("dddddddd-0420-4000-8000-%012d", timeoutRigN.Add(1))
	name := naming.SessionName(agentType, sid)
	mock.addSession(name, "/tmp/project")
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: agentType, AgentName: "chat", WorkingDir: "/tmp/project"}))
	term := &agentTerm{mockSessionTerminal: mock}
	h.terminal = term
	r := &timeoutRig{t: t, h: h, term: term, mock: mock, sid: sid, name: name, agent: liveAgent{sid, "chat", agentType, "team"}, t0: time.Date(2026, 11, 1, 5, 0, 0, 0, time.UTC), idle: claudeScreen(t, "idle")}
	if kind != "" {
		id := sid
		detail := `{"kind":"` + kind + `","tool_name":"Bash"}`
		_, err := h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "chat", SessionID: &id, EventType: "permission_request", Summary: "Waiting for the user: " + kind + " (Bash)", DetailJSON: &detail})
		require.NoError(t, err)
	}
	mock.onRaw = func(string) {
		mock.mu.Lock()
		keys := append([]string(nil), mock.raw[name]...)
		mock.mu.Unlock()
		if r.onKeys != nil {
			r.onKeys(keys)
			return
		}
		r.show(r.idle) // the dialog closed: the CLI's input box
	}
	r.show(screen)
	s, shown, err := h.readPromptScreen(ctx, name, agentType, sid)
	require.NoError(t, err)
	require.True(t, shown, "the screen parses as a prompt")
	h.dialogs.observe(sid, s, true, r.t0, atDialogMinutes, true)
	h.dialogs.observe(sid, s, true, r.t0.Add(dialogEvery), atDialogMinutes, true)
	return r
}

// show puts s on the agent's screen: what the gate reads and what the prompt parser reads.
func (r *timeoutRig) show(s string) {
	r.term.show(s)
	r.mock.mu.Lock()
	r.mock.outputs[r.name] = s
	r.mock.mu.Unlock()
}

func (r *timeoutRig) keys() []string {
	r.mock.mu.Lock()
	defer r.mock.mu.Unlock()
	return append([]string(nil), r.mock.raw[r.name]...)
}

// try runs the timeout at after (15 minutes) and 16 minutes past t0.
func (r *timeoutRig) try() string {
	return r.h.dialogTimeout(context.Background(), r.agent, 15*time.Minute, r.t0.Add(16*time.Minute))
}

func (r *timeoutRig) closeEvents() []map[string]any {
	r.t.Helper()
	evs, err := r.h.ts.ListAgentEvents(context.Background(), "chat", 200, &r.sid)
	require.NoError(r.t, err)
	var out []map[string]any
	for _, e := range evs {
		if e.EventType == "request_resolved" && e.DetailJSON != nil && strings.Contains(*e.DetailJSON, "dialog_timeout") {
			var d map[string]any
			require.NoError(r.t, json.Unmarshal([]byte(*e.DetailJSON), &d))
			out = append(out, d)
		}
	}
	return out
}

func TestTheDialogTimeoutNoticeIsFixedAndHasNoDigit(t *testing.T) {
	assert.Equal(t, "[Coral] A question you asked waited longer than the limit the operator set and was closed without an answer. Coral did not choose for you. If you still need that decision, post the question and its options to the Operator as one coral-board message, then go on with your other work and leave that decision until the answer arrives. Do not retry the same action before the operator answers.", dialogTimeoutNotice)
	assert.False(t, strings.ContainsFunc(dialogTimeoutNotice, unicode.IsDigit), "a digit could answer a menu")
	assert.True(t, strings.HasPrefix(dialogTimeoutNotice, "[Coral"), "a typed notice starts with a fixed opener")
}

func TestTheDialogTimeoutIsOffByDefaultAndItsWaitIsBounded(t *testing.T) {
	d := board.DefaultHealthSettings().DialogTimeout
	assert.False(t, d.On, "off by default")
	assert.Equal(t, 15, d.AfterMin)
	for in, want := range map[int]int{0: 15, 1: 10, 9: 10, 10: 10, 30: 30, 5000: 1440} {
		h := board.DefaultHealthSettings()
		h.DialogTimeout.AfterMin = in
		assert.Equal(t, want, h.Clamp().DialogTimeout.AfterMin, "after_min %d", in)
	}
	assert.Contains(t, board.HealthDialogTimeout{AfterMin: 9}.Problem(), "outside 10 to 1440")
	assert.Empty(t, board.HealthDialogTimeout{AfterMin: 0}.Problem(), "0 is the default")
	_, h, _, _ := setupSessionsTestServer(t)
	_, _, timeout := h.dialogMinutes(context.Background(), "a-team")
	assert.Zero(t, timeout, "a team that never turned it on has no timeout")
	_, _, timeout = h.dialogMinutes(context.Background(), "")
	assert.Zero(t, timeout, "an agent on no board has none: the notice tells it to ask on the board")
	require.NoError(t, h.bs.SetHealthSettings(context.Background(), "a-team", func() board.HealthSettings {
		s := board.DefaultHealthSettings()
		s.DialogTimeout = board.HealthDialogTimeout{On: true, AfterMin: 20}
		return s
	}()))
	_, _, timeout = h.dialogMinutes(context.Background(), "a-team")
	assert.Equal(t, 20*time.Minute, timeout)
}

// The close for each CLI and kind: only the reject labelled exactly "No", or Esc; never an allow; nothing for what is not mapped.
func TestTheDialogTimeoutClosesEachKindOnlyTheSafeWay(t *testing.T) {
	parse := func(text string) promptScreen {
		s, ok := parsePromptScreen(text)
		require.True(t, ok)
		markApprovalKinds("claude", text, &s)
		return s
	}
	perm := parse(claudeScreen(t, "permission_menu"))
	got, ok := dialogCloseFor("claude", "permission", perm)
	require.True(t, ok)
	assert.Equal(t, []string{"4"}, got.keys, "the option labelled exactly No")
	assert.Equal(t, dialogDeclined, got.how)

	// A reject that is not exactly "No" ("No, and tell Claude what to do differently"): Esc, never its digit.
	noAnd := perm
	noAnd.Options = append([]promptOption(nil), perm.Options...)
	noAnd.Options[3].Label = "No, and tell Claude what to do differently"
	got, ok = dialogCloseFor("claude", "permission", noAnd)
	require.True(t, ok)
	assert.Equal(t, []string{"Escape"}, got.keys)
	// Two "No" rows: which one is unclear, so Esc.
	twoNo := perm
	twoNo.Options = append(append([]promptOption(nil), perm.Options...), promptOption{N: 5, Label: "No"})
	got, _ = dialogCloseFor("claude", "permission", twoNo)
	assert.Equal(t, []string{"Escape"}, got.keys)

	plan := parse(claudeScreen(t, "plan_approval"))
	got, ok = dialogCloseFor("claude", "plan", plan)
	require.True(t, ok)
	assert.Equal(t, []string{"Escape"}, got.keys, "a plan with no No row: Esc, never a Yes")
	question := parse(claudeScreen(t, "question"))
	got, ok = dialogCloseFor("claude", "question", question)
	require.True(t, ok)
	assert.Equal(t, []string{"Escape"}, got.keys)
	assert.Equal(t, dialogCancelled, got.how)
	got, ok = dialogCloseFor("codex", "permission", perm)
	require.True(t, ok)
	assert.Equal(t, []string{"Escape"}, got.keys, "Codex: its documented cancel")

	for _, c := range []struct {
		name, agentType, kind string
		s                     promptScreen
	}{
		{"gemini", "gemini", "permission", perm},
		{"agy", "agy", "permission", perm},
		{"an elicitation", "claude", "elicitation", perm},
		{"a sign-in", "claude", "login", perm},
		{"a launch prompt", "claude", "startup", perm},
		{"no kind", "claude", "", perm},
		{"a menu without numbers", "claude", "permission", func() promptScreen { s := perm; s.Unnumbered = true; return s }()},
		{"a dialog with a heading (Hooks need review)", "codex", "permission", func() promptScreen { s := perm; s.Title = "Hooks need review"; return s }()},
		{"a review step", "claude", "question", func() promptScreen {
			s := question
			s.Review = []promptReviewItem{{Question: "q", Answer: "a"}}
			return s
		}()},
	} {
		_, ok := dialogCloseFor(c.agentType, c.kind, c.s)
		assert.False(t, ok, c.name)
	}
	// Whatever the screen, a close is Esc or the digit of a reject: never an allow option's digit.
	for _, kind := range []string{"permission", "plan", "question"} {
		for _, s := range []promptScreen{perm, plan, question, noAnd} {
			if got, ok := dialogCloseFor("claude", kind, s); ok && got.keys[0] != "Escape" {
				n := got.keys[0]
				for _, o := range s.Options {
					if fmt.Sprint(o.N) == n {
						assert.True(t, optionIsReject(o), "%s: %q is not a reject", kind, o.Label)
					}
				}
			}
		}
	}
	assert.True(t, dialogScreenExcluded(claudeTrustScreen(t)), "the folder-trust screen at launch is never closed")
}

func TestTheDialogTimeoutClosesAPermissionWithNoAndTypesTheNotice(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	require.True(t, r.h.deriveSingleSessionState(context.Background(), r.sid, 0).NeedsInput)
	assert.Equal(t, timeoutDone, r.try())
	assert.Equal(t, []string{"4"}, r.keys(), "the reject labelled No, once")
	typed, _ := r.term.counts()
	assert.Equal(t, []string{dialogTimeoutNotice}, typed, "the notice, once, after the box came back")
	evs := r.closeEvents()
	require.Len(t, evs, 1)
	assert.Equal(t, "declined", evs[0]["how"])
	assert.EqualValues(t, 16, evs[0]["minutes"])
	assert.False(t, r.h.deriveSingleSessionState(context.Background(), r.sid, 0).NeedsInput, "the wait is resolved")

	// One close per episode: the same prompt back on screen is never closed again.
	r.show(claudeScreen(t, "permission_menu"))
	s, _, _ := r.h.readPromptScreen(context.Background(), r.name, "claude", r.sid)
	r.h.dialogs.observe(r.sid, s, true, r.t0, atDialogMinutes, true)
	r.h.dialogs.observe(r.sid, s, true, r.t0.Add(dialogEvery), atDialogMinutes, true)
	assert.Equal(t, timeoutNotDue, r.try())
	assert.Len(t, r.keys(), 1, "never retried")
}

func TestTheDialogTimeoutCancelsAQuestionWithEsc(t *testing.T) {
	r := newTimeoutRig(t, "claude", "question", claudeScreen(t, "question"))
	assert.Equal(t, timeoutDone, r.try())
	assert.Equal(t, []string{"Escape"}, r.keys())
	require.Len(t, r.closeEvents(), 1)
	assert.Equal(t, "cancelled", r.closeEvents()[0]["how"])
}

func TestTheDialogTimeoutWaitsForItsMinutes(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	assert.Equal(t, timeoutNotDue, r.h.dialogTimeout(context.Background(), r.agent, 15*time.Minute, r.t0.Add(14*time.Minute)))
	assert.Empty(t, r.keys())
}

// A person at the agent keeps Coral's hands off: a focused dashboard terminal view of it, or typing in its terminal, in the last 2 minutes.
func TestADashboardTerminalFocusedOnTheAgentBlocksTheTimeout(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	r.h.focus.note(r.sid, "ws-a", true, r.t0.Add(15*time.Minute))
	assert.Equal(t, timeoutPresent, r.try())
	assert.Empty(t, r.keys())
	r.h.focus.note(r.sid, "ws-a", true, r.t0.Add(13*time.Minute)) // the last report is older than 2 minutes: nobody is looking
	assert.Equal(t, timeoutDone, r.try())
}

func TestAPersonTypingInTheTerminalBlocksTheTimeout(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	terminalinput.Record(terminalinput.Person, r.name, terminalinput.Keys, "x")
	assert.Equal(t, timeoutPresent, r.try())
	assert.Empty(t, r.keys())
}

// Nothing is closed or typed when the notice could not follow the close: the person paused notices, a send of theirs is in flight.
func TestNothingIsClosedWhenTheGateWouldHoldTheNotice(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	ptymanager.PauseNotices(r.sid, time.Minute)
	t.Cleanup(func() { ptymanager.ResumeNotices(r.sid) })
	assert.Equal(t, timeoutGateHolds, r.try())
	ptymanager.ResumeNotices(r.sid)
	end := ptymanager.BeginPersonSend(r.sid)
	assert.Equal(t, timeoutGateHolds, r.try())
	end()
	assert.Empty(t, r.keys())
	typed, _ := r.term.counts()
	assert.Empty(t, typed)
}

// The proof for the census (guardScreen): re-read inside the lock, a screen that is not the same prompt (a draft in the box, a look-alike menu, another question) gets no key.
func TestTheDialogTimeoutSendsNothingWhenTheScreenIsNotThePrompt(t *testing.T) {
	for name, screen := range map[string]string{
		"a draft in the box": claudeScreen(t, "draft"),
		"another prompt":     claudeScreen(t, "question"),
		"the agent at work":  claudeScreen(t, "working"),
		"a look-alike menu":  strings.Replace(claudeScreen(t, "permission_menu"), "Do you want to proceed?", "Do you want to make this edit?", 1),
	} {
		t.Run(name, func(t *testing.T) {
			r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
			r.show(screen)
			assert.Equal(t, timeoutChanged, r.try())
			assert.Empty(t, r.keys())
			typed, _ := r.term.counts()
			assert.Empty(t, typed)
		})
	}
}

// A person's answer and Coral's close never both go: while the answer holds the agent's lock the timeout skips; once the answer went, the screen is another and nothing is sent.
func TestAnAnswerRacingTheCloseLeavesOnlyOneToGo(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	unlock := r.h.lockAgent(r.sid)
	assert.Equal(t, timeoutBusy, r.try())
	r.show(r.idle) // the person's answer closed it
	unlock()
	assert.Equal(t, timeoutChanged, r.try())
	assert.Empty(t, r.keys())
}

// The close went but the CLI's input box never came back: nothing is typed, and the event says so.
func TestNoNoticeIsTypedWhenTheInputBoxDoesNotReturn(t *testing.T) {
	old := promptClearTimeout
	promptClearTimeout = 200 * time.Millisecond
	t.Cleanup(func() { promptClearTimeout = old })
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	r.onKeys = func([]string) { r.show(" ") } // the screen is blank after the close: no input box
	assert.Equal(t, timeoutNoBox, r.try())
	typed, _ := r.term.counts()
	assert.Empty(t, typed)
	require.Len(t, r.closeEvents(), 1)
	assert.Equal(t, timeoutNoBox, r.closeEvents()[0]["outcome"])
}

func TestAnAgentWithAutoAcceptOnIsLeftToIt(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	_, err := r.h.ss.EnableAutoAccept(context.Background(), r.sid, "test", 0)
	require.NoError(t, err)
	assert.Equal(t, timeoutExcluded, r.try())
	assert.Empty(t, r.keys())
}

func TestAnUnmappedCLIIsLeftAlone(t *testing.T) {
	r := newTimeoutRig(t, "gemini", "permission", claudeScreen(t, "permission_menu"))
	assert.Equal(t, timeoutExcluded, r.try())
	assert.Empty(t, r.keys())
}

// Security's MUST 3: dialog_timeout is the Operator's alone to write. An agent's token, or its command line without the Operator's signature, gets 403 whatever it claims, and the setting stays
// off; the dashboard sets it; a wait outside 10 to 1440 minutes is refused, not clamped.
func TestOnlyTheOperatorSetsTheDialogTimeout(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-a", nil, "all")
	require.NoError(t, err)
	put := func(body string, mod func(*http.Request)) int {
		req := httptest.NewRequest(http.MethodPut, "/api/board/team/settings", bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		mod(req)
		rec := httptest.NewRecorder()
		h.UpdateBoardSettings(rec, req)
		return rec.Code
	}
	on := `{"subscriber_id":"Operator","health":{"dialog_timeout":{"on":true,"after_min":12}}}`
	code := put(on, func(r *http.Request) {
		*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-a"}))
	})
	assert.Equal(t, http.StatusForbidden, code, "an agent token")
	code = put(on, func(r *http.Request) { r.Header.Set("User-Agent", "coral-board/1.0") })
	assert.Equal(t, http.StatusForbidden, code, "an unsigned agent command line")
	assert.False(t, h.bs.GetHealthSettings(ctx, "team").DialogTimeout.On, "still off")
	assert.NotEmpty(t, operatorOnlyRoutes["PUT /api/board/{project}/settings"], "and the route is operator-only before the handler")

	dashboard := func(r *http.Request) { r.Header.Set("User-Agent", "Mozilla/5.0") }
	assert.Equal(t, http.StatusBadRequest, put(`{"subscriber_id":"Operator","health":{"dialog_timeout":{"on":true,"after_min":5}}}`, dashboard), "under the 10-minute minimum")
	assert.False(t, h.bs.GetHealthSettings(ctx, "team").DialogTimeout.On)
	require.Equal(t, http.StatusOK, put(on, dashboard))
	got := h.bs.GetHealthSettings(ctx, "team")
	assert.Equal(t, board.HealthDialogTimeout{On: true, AfterMin: 12}, got.DialogTimeout)
	assert.False(t, got.On, "the rest of the health setup is as it was: the patch names only the timeout")
}

// closingOpencode is the fake opencode server whose reply takes the request off its list, as the real one does.
type closingOpencode struct{ *fakeOpencode }

func (f closingOpencode) ReplyPermission(ctx context.Context, key, id, reply string) error {
	err := f.fakeOpencode.ReplyPermission(ctx, key, id, reply)
	var left []opencode.PermissionRequest
	for _, p := range f.perms {
		if p.ID != id {
			left = append(left, p)
		}
	}
	f.perms = left
	return err
}

// opencode's request is rejected through its server (never once or always), the oldest past the limit first, once; then the notice is typed.
func TestTheDialogTimeoutRejectsAnOpencodeRequestThroughItsServer(t *testing.T) {
	r := newTimeoutRig(t, "claude", "", r0Screen(t))
	r.agent.agentType = "opencode"
	pane := naming.SessionName("opencode", r.sid)
	r.mock.addSession(pane, "/tmp/project")
	r.show(r.idle)
	f := closingOpencode{&fakeOpencode{perms: []opencode.PermissionRequest{
		{ID: "per_new", Permission: "bash", Command: "ls", At: r.t0.Add(10 * time.Minute)},
		{ID: "per_old", Permission: "bash", Command: "rm -rf build", At: r.t0},
	}}}
	r.h.opencode = f
	now := r.t0.Add(16 * time.Minute)
	assert.Equal(t, timeoutDone, r.h.opencodeDialogTimeout(context.Background(), r.agent, 15*time.Minute, now))
	assert.Equal(t, []string{r.sid + "|per_old|reject"}, f.replied, "the oldest request past the limit, rejected")
	typed, _ := r.term.counts()
	assert.Equal(t, []string{dialogTimeoutNotice}, typed)
	assert.Equal(t, timeoutNotDue, r.h.opencodeDialogTimeout(context.Background(), r.agent, 15*time.Minute, now), "the newer one has not waited 15 minutes")
	r.h.focus.note(r.sid, "ws-a", true, now.Add(-time.Minute))
	assert.Equal(t, timeoutPresent, r.h.opencodeDialogTimeout(context.Background(), r.agent, 5*time.Minute, now), "a person at it: hands off")
	assert.Len(t, f.replied, 1)
}

func r0Screen(t *testing.T) string { return claudeScreen(t, "permission_menu") }

// Security's SHOULD 1 on #420: presence is per view. A focused view stays present while another view of the same agent (a second tab, a phone, a Hub mirror) says it is not focused; only
// the focused view's own blur, or its socket closing, ends it.
func TestAFocusedViewStaysPresentWhileAnotherViewIsNotFocused(t *testing.T) {
	var f terminalFocus
	now := time.Date(2026, 11, 1, 5, 0, 0, 0, time.UTC)
	f.note("sid", "view-a", true, now)
	f.note("sid", "view-b", false, now)
	assert.True(t, f.within("sid", dialogPresence, now), "view A is focused: present")
	f.note("sid", "view-b", true, now)
	f.closed("sid", "view-b")
	assert.True(t, f.within("sid", dialogPresence, now), "view B's socket closing leaves view A")
	f.note("sid", "view-a", false, now)
	assert.False(t, f.within("sid", dialogPresence, now), "view A blurred: nobody")
	f.note("sid", "view-a", true, now)
	f.closed("sid", "view-a")
	assert.False(t, f.within("sid", dialogPresence, now), "view A's socket closed")
	assert.Empty(t, f.m, "nothing is kept for an agent with no view")
	f.note("sid", "", true, now)
	assert.False(t, f.within("sid", dialogPresence, now), "a report from no view counts for nothing")
}

// Security's SHOULD 2 on #420: a close that did not go (opencode did not take the reject) is recorded as an event of its own and does not resolve the agent's wait; it is not retried.
func TestAFailedCloseLeavesTheWaitOpen(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", r0Screen(t))
	r.agent.agentType = "opencode"
	r.mock.addSession(naming.SessionName("opencode", r.sid), "/tmp/project")
	r.show(r.idle)
	f := &fakeOpencode{perms: []opencode.PermissionRequest{{ID: "per_old", Permission: "bash", Command: "ls", At: r.t0}}, replyErr: fmt.Errorf("the server went away")}
	r.h.opencode = f
	now := r.t0.Add(16 * time.Minute)
	assert.Equal(t, timeoutSendFailed, r.h.opencodeDialogTimeout(context.Background(), r.agent, 15*time.Minute, now))
	assert.Empty(t, r.closeEvents(), "no request_resolved")
	evs, err := r.h.ts.ListAgentEvents(context.Background(), "chat", 200, &r.sid)
	require.NoError(t, err)
	var failed int
	for _, e := range evs {
		if e.EventType == "dialog_close_failed" {
			failed++
		}
	}
	assert.Equal(t, 1, failed, "the failure is recorded")
	assert.True(t, r.h.deriveSingleSessionState(context.Background(), r.sid, 0).NeedsInput, "the wait stays open")
	typed, _ := r.term.counts()
	assert.Empty(t, typed, "no notice for a close that did not go")
	assert.Equal(t, timeoutNotDue, r.h.opencodeDialogTimeout(context.Background(), r.agent, 15*time.Minute, now), "never retried")
}
