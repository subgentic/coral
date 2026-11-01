package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// Some tags are the Operator's word, set by a decision or a click and read by Needs you (#11645): an agent's own tags never carry them, whatever its case or spacing.
func TestAgentTagsNeverCarryTheOperatorsStates(t *testing.T) {
	for _, word := range []string{"read", "ignored", "saved", "denied", "approved", "changes requested", "superseded", "READ", "  Changes   Requested "} {
		assert.Empty(t, CleanArtifactTags([]string{word}), word)
		assert.True(t, OperatorArtifactTag(word), word)
	}
	assert.Equal(t, []string{"for review", "internal"}, CleanArtifactTags([]string{"read", "for review", "denied", "internal", "saved"}), "the others stay, in order")
	for _, word := range []string{"for review", "internal", "final", "draft", "reader", "readme"} {
		assert.False(t, OperatorArtifactTag(word), word)
	}
	// The Operator's own route still takes them.
	got, err := NormalizeArtifactTags([]string{"read", "saved"})
	assert.NoError(t, err)
	assert.Equal(t, []string{"read", "saved"}, got)
}
