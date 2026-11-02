package skills

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The example skills Coral ships (#12463): three, each a valid skill that an agent could publish (Markdown only), named like its folder, the same bytes on every build.
func TestTheStarterSkillsAreValidMarkdownOnlyAndStable(t *testing.T) {
	a, err := StarterZips()
	require.NoError(t, err)
	var names []string
	for _, z := range a {
		names = append(names, z.Name)
		sk, err := Parse(z.Data)
		require.NoError(t, err, z.Name)
		assert.Equal(t, z.Name, sk.Name, "the skill is named like its folder")
		assert.True(t, AgentMayPublish(sk), "%s holds only what an agent's skill may", z.Name)
		assert.Zero(t, sk.Scripts(), z.Name)
		assert.Zero(t, sk.NotReviewable(), z.Name)
		assert.Len(t, sk.Files, 1, "SKILL.md alone")
		assert.NotContains(t, sk.Description, "\n", z.Name)
		assert.True(t, strings.HasPrefix(sk.Description, "How"), "%s: a description that says what it is for", z.Name)
	}
	assert.Equal(t, []string{"creating-a-coral-automation", "creating-coral-skills", "working-in-a-coral-team"}, names)
	b, err := StarterZips()
	require.NoError(t, err)
	for i := range a {
		assert.Equal(t, a[i].Data, b[i].Data, "the same bytes each time, so the digest changes only with the text")
	}
}
