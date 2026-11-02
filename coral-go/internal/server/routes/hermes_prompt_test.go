package routes

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #12170: Hermes's approval and clarify prompts, read from the tester's captures of Hermes v0.22.5 (the prompt left open; the pane is 120 columns).
func hermesScreen(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "hermes_prompts", name+".txt"))
	require.NoError(t, err)
	return string(b)
}

func optionLabels(s promptScreen) []string {
	var out []string
	for _, o := range s.Options {
		out = append(out, o.Label)
	}
	return out
}

func TestAHermesApprovalShowsItsCommandAndItsFourAnswers(t *testing.T) {
	s, ok := parsePromptScreen(hermesScreen(t, "a1_approval_short"))
	require.True(t, ok, "the box is a prompt")
	assert.Equal(t, promptKindApproval, s.Kind)
	assert.Equal(t, "Dangerous command: recursive delete", s.Title)
	assert.Equal(t, "rm -rf /home/tester/dangerdir", s.Target, "the command the card shows")
	assert.Equal(t, []string{"Allow once", "Allow for this session", "Add to permanent allowlist", "Deny"}, optionLabels(s))
	assert.True(t, s.Options[0].Selected, "the pointer is on the first")
	for i, want := range []string{"allow_once", "allow_always", "allow_always", "reject"} {
		assert.Equal(t, want, s.Options[i].Kind, s.Options[i].Label)
		assert.Equal(t, i+1, s.Options[i].N)
		assert.Equal(t, "select", s.Options[i].Action)
	}
	assert.False(t, s.OnlyReject)
	assert.NotEmpty(t, s.AskID)
}

func TestAHermesApprovalWithALongCommandShowsTheWholeCommandAndNoShowFullRow(t *testing.T) {
	s, ok := parsePromptScreen(hermesScreen(t, "a2_approval_long"))
	require.True(t, ok)
	assert.Equal(t, "rm -rf /home/tester/dangerdir/a_long_directory_name_segment_1/a_long_directory_name_segment_2/a_long_directory_name_segment_3/a_long_directory_name_segment_4/a_long_directory_name_segment_5/a_long_directory_name_segment_6", s.Target,
		"the rows the box wrapped inside a word are joined without a space")
	assert.Equal(t, []string{"Allow once", "Allow for this session", "Add to permanent allowlist", "Deny"}, optionLabels(s), "'Show full command' draws the command, it is not an answer")
}

func TestAHermesClarifyIsAQuestionWithItsOptionsAndNotThePermissionOfAnApproval(t *testing.T) {
	s, ok := parsePromptScreen(hermesScreen(t, "b_clarify3"))
	require.True(t, ok)
	assert.Equal(t, promptKindQuestion, s.Kind)
	assert.Equal(t, "Which colour should the report use?", s.Question)
	assert.Equal(t, []string{"blue (Recommended)", "green", "red"}, optionLabels(s), "the free-text row is typed in the terminal")
	assert.True(t, s.Options[0].Selected)
	assert.Empty(t, s.Target)
	for _, o := range s.Options {
		assert.Empty(t, o.Kind, "no option of a question is an allow or a reject")
	}
}

func TestAHermesClarifyWithNoOptionsIsNotAMenu(t *testing.T) {
	_, ok := parsePromptScreen(hermesScreen(t, "c_clarify0"))
	assert.False(t, ok, "the person types the answer in the terminal")
}

func TestAHermesPromptIsNotReadFromWhatTheAgentPrintsAbove(t *testing.T) {
	// a command's own output that looks like the box, with no footer under it: no prompt
	box := "╭────────────────────╮\n│ ⚠️   Dangerous Command │\n│                    │\n│ rm -rf x           │\n│                    │\n│ ❯ 1. Allow once    │\n│   2. Deny          │\n╰────────────────────╯\n"
	_, ok := parsePromptScreen(box + "  ↑/↓ to select, Enter to confirm  (292s)\n")
	assert.True(t, ok, "the same box with Hermes's footer is the prompt")
	_, ok = parsePromptScreen(box + "$ \n")
	assert.False(t, ok, "without the footer it is only text on the screen")
}

// The open request the hook reports ("Wants to use approval", read from nothing) takes its kind and its words from the box on the screen: a clarify counts under Question, not Permission (the tester's #12042).
func TestAHermesClarifyCountsAsAQuestionAndACommandApprovalSaysWhatItRuns(t *testing.T) {
	derive := func(screen string) SessionState {
		ev := StateEvent{Type: "permission_request", Kind: "permission", Summary: "Waiting for the user: approval", ToolName: "approval", Wants: "Wants to use approval"}
		hermesRequestFromScreen(&ev, screen)
		return DeriveSessionState(SessionStateInput{Events: []StateEvent{ev}})
	}
	st := derive(hermesScreen(t, "b_clarify3"))
	assert.True(t, st.NeedsInput)
	assert.Equal(t, "question", st.WaitingKind)
	assert.Contains(t, st.WaitingSummary, "Which colour should the report use?")

	st = derive(hermesScreen(t, "c_clarify0")) // no options: still a question
	assert.Equal(t, "question", st.WaitingKind)
	assert.Contains(t, st.WaitingSummary, "What name should the report have?")

	st = derive(hermesScreen(t, "a1_approval_short"))
	assert.Equal(t, "permission", st.WaitingKind)
	assert.Equal(t, "Wants to run: rm -rf /home/tester/dangerdir", st.WaitingWants)

	st = derive("Welcome to Hermes Agent!\n❯ \n") // no box: the hook's words stand
	assert.Equal(t, "permission", st.WaitingKind)
}

// The tester's browser pass on #12170: a command with U+200B inside a path got all four buttons, because the card is built from the screen and the terminal drops that character, while the chat's step row (Hermes's own
// stored tool call) shows it. The stored command of the call is judged by the same rule as every other CLI's: Reject only, and the note names the character.
func TestAHermesApprovalWhoseStoredCommandHidesACharacterOffersRejectOnly(t *testing.T) {
	const zero = "​"
	parse := func() promptScreen {
		s, ok := parsePromptScreen(hermesScreen(t, "a1_approval_short"))
		require.True(t, ok)
		return s
	}
	rows := func(cmd string) []map[string]any {
		return []map[string]any{{"type": "assistant", "tool_uses": []map[string]any{{"name": "terminal", "command": "echo older"}}}, {"type": "assistant", "tool_uses": []map[string]any{{"name": "terminal", "command": cmd}}}}
	}

	s := parse()
	require.False(t, s.OnlyReject, "the screen alone shows nothing hidden")
	before := s.AskID
	stored := hermesCommandOf(rows("rm -rf /home/tester/dan" + zero + "gerdir"))
	assert.Equal(t, "rm -rf /home/tester/dan"+zero+"gerdir", stored, "the newest call's command")
	applyHermesCommand(&s, stored)
	assert.True(t, s.OnlyReject, "an invisible character: Deny only")
	assert.NotEmpty(t, s.Note)
	assert.Contains(t, strings.ToLower(s.Target), "dan<u+200b>gerdir", "the card shows the character written out where it is, not hidden")
	assert.NotContains(t, s.Target, zero)
	assert.NotEqual(t, before, s.AskID, "the ask is the stored command's, so an answer drawn for the other cannot answer this one")

	// the same command with nothing hidden changes nothing
	clean := parse()
	applyHermesCommand(&clean, hermesCommandOf(rows("rm -rf /home/tester/dangerdir")))
	assert.False(t, clean.OnlyReject)
	assert.Equal(t, "rm -rf /home/tester/dangerdir", clean.Target)

	// another call's command (or none stored) is not this approval's: the screen stands
	other := parse()
	applyHermesCommand(&other, "ls "+zero+"/tmp")
	assert.False(t, other.OnlyReject, "a different command is not judged for this one")
	applyHermesCommand(&other, "")
	assert.False(t, other.OnlyReject)

	// a clarify is not a command
	q, ok := parsePromptScreen(hermesScreen(t, "b_clarify3"))
	require.True(t, ok)
	applyHermesCommand(&q, "x"+zero)
	assert.False(t, q.OnlyReject)
}

// The wiring: the handler reads the stored command of the agent's newest tool call from its own team's state.db, by the Hermes session its hooks bound (hermesTranscriptRows), and nothing of another session's.
func TestTheStoredCommandOfAHermesAgentIsReadFromItsOwnSessionOnly(t *testing.T) {
	_, handler, _, ss := setupSessionsTestServer(t)
	sid, team := "00000000-0000-0000-0000-00000000e11d", "team-a"
	hid, other := "local-"+strings.Repeat("c5", 32), "local-"+strings.Repeat("d5", 32)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "hermes", AgentName: "hermes-c", WorkingDir: "/tmp/test", BoardName: &team}))
	w := writeHermesState(t, agent.HermesAgentHome(handler.cfg.CoralDir(), team, sid))
	call := func(session, cmd string) {
		args, _ := json.Marshal(map[string]string{"command": cmd})
		calls, _ := json.Marshal([]map[string]any{{"id": "c1", "type": "function", "function": map[string]any{"name": "terminal", "arguments": string(args)}}})
		_, err := w.Exec(`INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, 'assistant', '', ?, 1788000000)`, session, string(calls))
		require.NoError(t, err)
	}
	call(hid, "rm -rf /home/tester/dan​gerdir")
	call(other, "THE OTHER SESSION'S COMMAND")
	assert.Empty(t, handler.hermesStoredCommand(context.Background(), sid), "no link yet: nothing is read")
	require.NoError(t, transcriptlink.BindHermes(handler.cfg.CoralDir(), sid, hid))
	assert.Equal(t, "rm -rf /home/tester/dan​gerdir", handler.hermesStoredCommand(context.Background(), sid), "the bound session's newest call, with its hidden character")
}

// QA's SHOULD on #12170: a box with no command rows is not a prompt, so an empty card never offers Allow buttons for nothing.
func TestAHermesApprovalBoxWithNoCommandIsNotAPrompt(t *testing.T) {
	const footer = "  ↑/↓ to select, Enter to confirm  (292s)\n"
	opts := "│ ❯ 1. Allow once                 │\n│   2. Allow for this session     │\n│   3. Deny                       │\n"
	for name, box := range map[string]string{
		"heading, blank rows, then the options": "╭─────────────────────────────────╮\n│ ⚠️   Dangerous Command           │\n│                                 │\n│                                 │\n" + opts + "│                                 │\n│ recursive delete                │\n╰─────────────────────────────────╯\n",
		"heading, one blank row, the options":   "╭─────────────────────────────────╮\n│ ⚠️   Dangerous Command           │\n│                                 │\n" + opts + "│                                 │\n│ recursive delete                │\n╰─────────────────────────────────╯\n",
		"heading and options, no blank rows":    "╭─────────────────────────────────╮\n│ ⚠️   Dangerous Command           │\n" + opts + "╰─────────────────────────────────╯\n",
		"heading only":                          "╭─────────────────────────────────╮\n│ ⚠️   Dangerous Command           │\n╰─────────────────────────────────╯\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, ok := parsePromptScreen(box + footer)
			assert.False(t, ok, "no command, no Allow buttons")
		})
	}
	// the same box with a command is the prompt
	with := "╭─────────────────────────────────╮\n│ ⚠️   Dangerous Command           │\n│                                 │\n│ rm -rf x                        │\n│                                 │\n" + opts + "╰─────────────────────────────────╯\n"
	s, ok := parsePromptScreen(with + footer)
	require.True(t, ok)
	assert.Equal(t, "rm -rf x", s.Target)
}

// Security's MUST on #12170 (confirmed on a real Hermes by the tester): Hermes cuts a long command in its OWN box at about 200 characters and ends it "… (choose Show full command)", so the screen's command never equals
// the stored one and the over-the-cap and hidden-character rules never fired: a person could allow a 4 KB command having seen its first 200 characters. The stored command is matched by prefix then, and judged; a cut
// with no stored command to match fails closed to Reject only.
func hermesCutScreen(shown string) string {
	const inner = 62
	var rows []string
	for rest := shown + "… (choose Show full command)"; rest != ""; {
		n := len([]rune(rest))
		if n > inner {
			n = inner
		}
		rows = append(rows, string([]rune(rest)[:n]))
		rest = string([]rune(rest)[n:])
	}
	pad := func(s string) string { return "│ " + s + strings.Repeat(" ", inner-len([]rune(s))) + " │\n" }
	var b strings.Builder
	b.WriteString("╭" + strings.Repeat("─", inner+2) + "╮\n" + pad("⚠️   Dangerous Command") + pad(""))
	for _, r := range rows {
		b.WriteString(pad(r))
	}
	b.WriteString(pad("") + pad("❯ 1. Allow once") + pad("  2. Allow for this session") + pad("  3. Add to permanent allowlist") + pad("  4. Deny") + pad("  5. Show full command") + pad("") + pad("recursive delete"))
	b.WriteString("╰" + strings.Repeat("─", inner+2) + "╯\n  ↑/↓ to select, Enter to confirm  (292s)\n")
	return b.String()
}

func TestAHermesCommandCutOnItsScreenIsJudgedByTheStoredCommandOrRefused(t *testing.T) {
	const zero = "​"
	shown := "rm -rf /home/tester/dangerdir/" + strings.Repeat("over_the_cap_segment_001_", 7) // about 200 characters, as Hermes shows
	parse := func() promptScreen {
		s, ok := parsePromptScreen(hermesCutScreen(shown))
		require.True(t, ok, "the cut box is a prompt")
		return s
	}
	rest := strings.Repeat("x", 4060)

	// over the cap: the stored command is longer than a card shows, so only Reject is offered
	s := parse()
	require.False(t, s.OnlyReject, "the screen alone is a short, plain command")
	applyHermesCommand(&s, shown+rest)
	assert.True(t, s.OnlyReject, "a 4 KB command seen as its first 200 characters: Deny only")
	assert.NotEmpty(t, s.Note)

	// a hidden character after the cut is in the stored command, not on the screen
	s = parse()
	applyHermesCommand(&s, shown+"abc"+zero+"def")
	assert.True(t, s.OnlyReject, "a character hidden after the cut")
	assert.Contains(t, strings.ToLower(s.Target), "<u+200b>")

	// a cut with nothing stored, or another call's command, fails closed: the person could not see the rest
	for name, stored := range map[string]string{"nothing stored": "", "another call's command": "ls /tmp"} {
		s = parse()
		applyHermesCommand(&s, stored)
		assert.True(t, s.OnlyReject, name)
		assert.Contains(t, strings.ToLower(s.Note), "cut", name)
	}

	// a short command whose box has the fifth row but no cut marker is as before
	clean, ok := parsePromptScreen(hermesScreen(t, "a2_approval_long"))
	require.True(t, ok)
	applyHermesCommand(&clean, "")
	assert.False(t, clean.OnlyReject, "no marker: the whole command was on the screen")
}
