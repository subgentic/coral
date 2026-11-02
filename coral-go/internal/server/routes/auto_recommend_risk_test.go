package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The brake's words (Security's read of #271): merge, install, uninstall, reset, revoke, revert, remove, purge, rebase and kill join delete, drop, force and push. Each is refused in the question, in a
// label and in a description, in the endings a person or an agent writes; a plain question beside them is still answered.
func TestAutoRecommendRefusesTheWordsOfAnIrreversibleChange(t *testing.T) {
	clean := recQuestion("Which color?", "Red (Recommended)", "Green")
	assert.Empty(t, recommendedOption(parsedQuestion(t, clean), clean).Why, "the control: a plain question is answered")
	for _, w := range []string{
		"merge", "Merges", "merged", "install", "installs", "installing", "uninstall", "uninstalls", "reset", "resets", "revoke", "revokes", "revoked", "revert", "reverts", "reverted",
		"remove", "removes", "removing", "purge", "purged", "rebase", "rebases", "kill", "kills", "killed",
		"delete", "deletes", "drop", "force", "push",
	} {
		inDescription := strings.Replace(clean, "A description of the option", "It will "+w+" the branch", 1)
		assert.NotEmpty(t, recommendedOption(parsedQuestion(t, inDescription), inDescription).Why, "description: "+w)
		inQuestion := strings.Replace(clean, "Which color?", "Should it "+w+" the branch?", 1)
		assert.NotEmpty(t, recommendedOption(parsedQuestion(t, inQuestion), inQuestion).Why, "question: "+w)
		inLabel := strings.Replace(clean, "Green", strings.ToUpper(w[:1])+w[1:]+" it", 1)
		assert.NotEmpty(t, recommendedOption(parsedQuestion(t, inLabel), inLabel).Why, "label: "+w)
	}
	// a word that only contains one of them is not one
	plain := strings.Replace(clean, "A description of the option", "A preset colour, calm and tidy", 1)
	assert.Empty(t, recommendedOption(parsedQuestion(t, plain), plain).Why)
}
