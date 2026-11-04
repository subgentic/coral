package ptymanager

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #13480: Codex refuses a model its login cannot use, and says so only on its own screen, once per turn it is nudged into; the agent looked idle while three of them sat for two hours with eleven unread messages.
func TestCodexModelRefusedOnScreen(t *testing.T) {
	const idle = "\n› Ask Codex to do anything\n\n  GPT-6.1-Sol default · ~/work · Coordinate frontend development\n  ? for shortcuts\n"
	for name, c := range map[string]struct{ screen, model string }{
		"as seen":                    {"› You have 5 unread messages on the message board. Run 'coral-board read' to see them.\n■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\n" + idle, "gpt-6.1-sol"},
		"wrapped at a narrow width":  {"› You have 5 unread messages on the message board. Run 'coral-board read' to\n  see them.\n■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT\naccount.\n" + idle, "gpt-6.1-sol"},
		"another model":              {"■ The 'o9-mini' model is not supported when using Codex with a ChatGPT account.\n" + idle, "o9-mini"},
		"repeated, the last one won": {"■ The 'a' model is not supported when using Codex with a ChatGPT account.\n› hi\n■ The 'b' model is not supported when using Codex with a ChatGPT account.\n" + idle, "b"},
	} {
		model, ok := CodexModelRefusedOnScreen(c.screen)
		assert.True(t, ok, name)
		assert.Equal(t, c.model, model, name)
	}
	for name, screen := range map[string]string{
		"idle":                    idle,
		"echo without the bullet": "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\n" + idle,
		"a pasted board line":     "[2026-11-04T12:00] Lead: ■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\n" + idle,
		"an indented quote":       "  > ■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account\n" + idle,
		"another error":           "■ stream error: connection reset\n" + idle,
		"usage limit":             "■ You've hit your usage limit. Try again in 3 days.\n" + idle,
		"long gone above":         "■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\n" + "line\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n" + idle,
	} {
		_, ok := CodexModelRefusedOnScreen(screen)
		assert.False(t, ok, name)
	}
}
