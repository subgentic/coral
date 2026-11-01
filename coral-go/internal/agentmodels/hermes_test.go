package agentmodels

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #11831: a Hermes agent takes its model with -m and its reasoning level with --reasoning <none|minimal|low|medium|high|xhigh|max|ultra> (hermes chat --help, v0.22.5, #11715). Coral lists no models for it
// (Hermes has no list command Coral knows): the model is typed or a custom one, and the models route answers an empty list, not an error.

func TestHermesThinkingLevelsAreTheCLIsOwn(t *testing.T) {
	want := []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
	assert.Equal(t, want, ThinkingLevels(at.Hermes))
	for _, l := range want {
		assert.True(t, ValidThinking(at.Hermes, l), l)
		assert.Equal(t, []string{"--reasoning", l}, ThinkingArgs(at.Hermes, l), l)
	}
	for _, l := range []string{"off", "Low", "low ", "--yolo", "high;ls", "ultra2", "\u202emax"} {
		assert.False(t, ValidThinking(at.Hermes, l), l)
		assert.Nil(t, ThinkingArgs(at.Hermes, l), l)
	}
	assert.True(t, ValidThinking(at.Hermes, ""), "the CLI's own default")
	assert.Nil(t, ThinkingArgs(at.Hermes, ""))
	// Pi's word is not Hermes's
	assert.Equal(t, []string{"--thinking", "off"}, ThinkingArgs(at.Pi, "off"))
}

func TestStripThinkingFlagsAlsoRemovesHermesReasoning(t *testing.T) {
	assert.Equal(t, []string{"-m", "x", "--yolo"}, StripThinkingFlags([]string{"-m", "x", "--reasoning", "high", "--yolo"}))
	assert.Equal(t, []string{"-m", "x"}, StripThinkingFlags([]string{"--reasoning=max", "-m", "x"}))
	assert.Equal(t, []string{"--yolo"}, StripThinkingFlags([]string{"--reasoning", "--yolo"}), "a bare --reasoning does not eat the next flag")
}

func TestHermesIsAFamilyWithCustomModelsAndNoList(t *testing.T) {
	assert.Equal(t, "hermes", Family(at.Hermes))
	assert.Contains(t, CustomFamilies, "hermes")
	assert.Equal(t, []string{"hermes"}, FamilyTypes("hermes"))
	assert.Equal(t, ThinkingLevels(at.Hermes), FamilyLevels("hermes"))

	models, source, err := FetchFromCLI(context.Background(), "hermes", "/nonexistent/hermes")
	require.NoError(t, err, "no list is asked of the CLI, so there is nothing to fail")
	assert.Empty(t, models)
	assert.Equal(t, "custom", source)
}
