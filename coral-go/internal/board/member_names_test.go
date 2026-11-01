package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #11687 (coral-hub's bug): an agent joined as "Security Reviewer 2:" (a trailing colon), and "@Security Reviewer 2" went to "Security Reviewer", which is a shorter member, so the agent it was for never got it.
func TestAMentionThatReachesAShorterMemberWhileANearerOneExistsIsRefused(t *testing.T) {
	names := []string{"Orchestrator", "Security Reviewer", "Security Reviewer 2:"}
	got := mentionWarnings("@Security Reviewer 2 please look at the patch", names)
	if assert.Len(t, got, 1, "%v", got) {
		assert.Contains(t, got[0], "'Security Reviewer 2:'", "it names the near match")
		assert.Contains(t, got[0], "'Security Reviewer'", "and the member it would have reached")
	}
	// In the middle of the text too; and when the nearer name is a title.
	assert.Len(t, mentionWarnings("thanks @Security Reviewer 2, done", names), 1)
	// What is not ambiguous passes: the shorter name alone, words that are not part of a name, the exact longer name, a numbered name that really exists.
	for _, ok := range []string{"@Security Reviewer please look", "@Security Reviewer is on it", "@Security Reviewer 2: hello is the exact (punctuated) form", "@Orchestrator 2 is not a member but is not near either"} {
		for _, w := range mentionWarnings(ok, names) {
			assert.NotContains(t, w, "reaches", ok)
		}
	}
	assert.Empty(t, mentionWarnings("@Security Reviewer 2 please", []string{"Security Reviewer", "Security Reviewer 2"}), "a member really named 'Security Reviewer 2' is reached")
	assert.Empty(t, mentionWarnings("@Backend Dev 2 is a numbered name", warnNames), "the existing numbered-name case stays fine")
}

func TestAMemberNameStartsAndEndsWithALetterOrADigit(t *testing.T) {
	for _, bad := range []string{"Security Reviewer 2:", ":Reviewer", "Dev.", "-Dev", "Dev,", "(Dev", "Dev)", "@Dev", "Dev!", "Dev?", "'Dev'", "\"Dev\"", "  Dev:  "} {
		assert.Error(t, ValidMemberName(bad), "%q", bad)
	}
	for _, ok := range []string{"Security Reviewer 2", "Backend Dev", "QA", "dev-2", "Dev_Ops", "R2", "C++ Dev", "Ünal", "hub-user-1234abcd", "claude-3f2a", "  Padded  "} {
		assert.NoError(t, ValidMemberName(ok), "%q", ok)
	}
	assert.NoError(t, ValidMemberName(""), "an empty name is the caller's own rule, not this one")
}
