package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #11399 (UX/UX Engineer's second read): the card keeps a refusing option by its KIND. Each CLI's real approval screen, captured in testdata, gives its approve-once option "allow_once", its refusal "reject" and its
// other Yes rows "allow_always", so the card does not rest on the words of the refusal ("No", "No, and tell Codex what to do differently (esc)", "No, cancel").
func TestAnApprovalsOptionsCarryTheirKindsFromTheCapturedScreens(t *testing.T) {
	for _, tc := range []struct {
		agent, screen string
		want          map[string]string // label prefix -> kind
	}{
		{at.Claude, "claude_bash", map[string]string{"Yes, and always": "allow_always", "No": "reject"}},
		{at.Codex, "codex_exec", map[string]string{"Yes, proceed": "allow_once", "Yes, and don't ask again": "allow_always", "No, and tell Codex": "reject"}},
		{at.Agy, "agy_command", map[string]string{"Yes, run command": "allow_once", "Yes, and always allow": "allow_always", "No, cancel": "reject"}},
	} {
		t.Run(tc.agent, func(t *testing.T) {
			text := autoAcceptScreen(t, tc.screen)
			s, ok := parsePromptScreen(text)
			require.True(t, ok)
			markApprovalKinds(tc.agent, text, &s)
			got := map[string]string{}
			var once int
			for _, o := range s.Options {
				if o.Kind == "allow_once" {
					once++
				}
				for prefix := range tc.want {
					if len(o.Label) >= len(prefix) && o.Label[:len(prefix)] == prefix {
						got[prefix] = o.Kind
					}
				}
			}
			assert.Equal(t, 1, once, "one approve-once option")
			for prefix, kind := range tc.want {
				if kind == "allow_once" {
					continue // the one the approval table marks
				}
				assert.Equal(t, kind, got[prefix], "%s: %q", tc.agent, prefix)
			}
		})
	}
}

func TestMoreWaysACLIWordsARefusalAreRejects(t *testing.T) {
	for _, l := range []string{"No", "No (recommended)", "No, cancel", "No, and tell Codex what to do differently (esc)", "Reject", "Deny", "Don't allow", "Don\u2019t allow", "Do not allow", "Decline", "Disallow", "Cancel", "Skip", "Not now"} {
		assert.True(t, isRejectLabel(l), l)
	}
	for _, l := range []string{"None of the above", "Nothing", "Nope", "Notify me", "Yes", "Allow once", "Yes, and don't ask again", "Skipper"} {
		assert.False(t, isRejectLabel(l), l)
	}
}
