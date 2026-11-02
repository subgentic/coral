package routes

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
