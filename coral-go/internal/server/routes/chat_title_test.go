package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/agent"
)

// #7756: a chat's title is its own title, else the first real message with its markdown off on one line, else the agent's name alone; the launch prompt is never one.
func TestChatTitle(t *testing.T) {
	launch := "You are the Lead.\n\n---\n\n" + agent.KnowledgeSectionHeading + "\n\n" + agent.KnowledgeSectionIntro + " Notes."
	cases := []struct {
		name, title, first, display, agent, want string
	}{
		{"its own title wins", "Login redirect", "typed first", "Lead", "lead-1", "Login redirect"},
		{"the first message, markdown off", "", "## Fix the **login** [redirect](http://x/y) in `auth.go`\nmore", "Lead", "lead-1", "Fix the login redirect in auth.go"},
		{"snake_case and a dunder stay", "", "fix history_label.js and user_id in __init__", "", "a", "fix history_label.js and user_id in __init__"},
		{"a ~/ path keeps its tilde", "", "go to ~/work/app", "", "a", "go to ~/work/app"},
		{"a lone * stays", "", "2 * 3 = 6", "", "a", "2 * 3 = 6"},
		{"emphasis that wraps words goes", "", "Make **this** work and *that* too, ~~not~~ now", "", "a", "Make this work and that too, not now"},
		{"a list bullet and a quote go", "", "- first item", "", "a", "first item"},
		{"only the launch prompt: the agent's name", "", launch, "Lead", "lead-1", "Lead"},
		{"no display name: the agent name", "", "", "", "lead-1", "lead-1"},
		{"a long message is cut to one line", "", strings.Repeat("word ", 60), "", "a", strings.TrimSpace(strings.Repeat("word ", 24)) + "…"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := chatTitle(c.title, c.first, c.display, c.agent)
			if strings.HasSuffix(c.want, "…") {
				assert.True(t, strings.HasSuffix(got, "…") && len([]rune(got)) <= chatTitleLimit+1, got)
				return
			}
			assert.Equal(t, c.want, got)
		})
	}
}
