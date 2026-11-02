package ptymanager

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #11967: Hermes shows a rotating hint in its empty box, in its own language: matched by an exact list (hermesHints) only the English ones are known. The tester's styled captures of a real Hermes (v0.22.5,
// tmux capture-pane -e): an EMPTY box is `❯ ` then the hint in italic (SGR 3) and colour 136; a box with typed text is `❯ ` then the text in the default colour, no italic. Security's conditions: the styling only adds
// a way to say "placeholder", never the only way to say "draft"; every cell of the box has it, the box is one short line, and the screen is Hermes's own (its welcome line). Anything else is a draft.
const (
	hermesRule    = "\x1b[38;5;102m────────────────────────────────────────────────────────────────────\x1b[39m\n"
	hermesWelcome = "\x1b[38;5;230mWelcome to Hermes Agent! Type your message or /help for commands.\x1b[39m\n\n"
	hermesStatus  = "\x1b[38;5;250m ⚕ \x1b[1m\x1b[38;5;220mstub-model\x1b[0m · ~/work (master)\x1b[39m\n"
)

func hermesScreen(welcome bool, boxLines ...string) string {
	s := ""
	if welcome {
		s += hermesWelcome
	}
	s += hermesRule
	for _, l := range boxLines {
		s += l + "\n"
	}
	return s + hermesRule + hermesStatus
}

func TestHermesPlaceholderByItsStyling(t *testing.T) {
	const italic136 = "\x1b[3m\x1b[38;5;136m"
	cases := map[string]struct {
		screen string
		want   bool
	}{
		"the real empty box, a hint no list knows (another locale)":         {hermesScreen(true, "\x1b[38;5;230m❯ "+italic136+"Frag irgendetwas oder tippe / für Befehle…\x1b[0m"), true},
		"the real empty box, an English hint":                               {hermesScreen(true, "\x1b[38;5;230m❯ "+italic136+"What changed in this repo recently?\x1b[0m"), true},
		"the real box with typed text":                                      {hermesScreen(true, "\x1b[38;5;230m❯ \x1b[39mmy draft text"), false},
		"typed text that is the hint's words, normal weight":                {hermesScreen(true, "\x1b[38;5;230m❯ \x1b[39mWhat changed in this repo recently?"), false},
		"italic and colour but not Hermes's screen (no welcome)":            {hermesScreen(false, "\x1b[38;5;230m❯ "+italic136+"Frag irgendetwas\x1b[0m"), false},
		"the hint followed by a person's normal-weight words":               {hermesScreen(true, "\x1b[38;5;230m❯ "+italic136+"Frag irgendetwas\x1b[0m und meine Frage"), false},
		"a person's text first, then italic":                                {hermesScreen(true, "\x1b[38;5;230m❯ \x1b[39mmeine Frage "+italic136+"Frag irgendetwas\x1b[0m"), false},
		"italic with the default colour":                                    {hermesScreen(true, "\x1b[38;5;230m❯ \x1b[39m\x1b[3mFrag irgendetwas\x1b[0m"), false},
		"italic in two different colours":                                   {hermesScreen(true, "\x1b[38;5;230m❯ "+italic136+"Frag \x1b[38;5;200mirgendetwas\x1b[0m"), false},
		"a box of two lines":                                                {hermesScreen(true, "\x1b[38;5;230m❯ "+italic136+"Frag irgendetwas\x1b[0m", italic136+"und noch eine Zeile\x1b[0m"), false},
		"a long line":                                                       {hermesScreen(true, "\x1b[38;5;230m❯ "+italic136+strings.Repeat("wort ", 30)+"\x1b[0m"), false},
		"a paste marker drawn in italic and the colour (Security's SHOULD)": {hermesScreen(true, "\x1b[38;5;230m❯ "+italic136+"[Pasted text #1 +42 lines]\x1b[0m"), false},
		"a paste marker with a hint's colours, another label":               {hermesScreen(true, "\x1b[38;5;230m❯ "+italic136+"[Pasted ~4 lines]\x1b[0m"), false},
		"an empty box":                         {hermesScreen(true, "\x1b[38;5;230m❯ "), false},
		"no box at all":                        {hermesWelcome + "just text\n", false},
		"italic reset with 23 before the rest": {hermesScreen(true, "\x1b[38;5;230m❯ \x1b[3m\x1b[38;5;136mFrag\x1b[23m irgendetwas\x1b[0m"), false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, c.want, hermesPlaceholderBox(c.screen))
		})
	}
}

type styledOnlyTerm struct {
	SessionTerminal
	screen string
}

func (s styledOnlyTerm) AgentScreenStyled(context.Context, string, string, string) (string, error) {
	return s.screen, nil
}

// It applies to a Hermes agent only: another agent's italic coloured line is not taken for a hint.
func TestStyledPlaceholderIsHermesOnly(t *testing.T) {
	screen := hermesScreen(true, "\x1b[38;5;230m❯ \x1b[3m\x1b[38;5;136mFrag irgendetwas\x1b[0m")
	in := AutomatedInput{Term: styledOnlyTerm{screen: screen}, Name: "n"}
	assert.True(t, in.styledSuggestionOnly(context.Background(), "hermes", "s"))
	assert.False(t, in.styledSuggestionOnly(context.Background(), "claude", "s"))
	assert.False(t, in.styledSuggestionOnly(context.Background(), "codex", "s"))
}
