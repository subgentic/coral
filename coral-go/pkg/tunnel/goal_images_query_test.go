package tunnel

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #11650: the goal picture route reads one query word, version_of (the picture just added that a marked-up copy follows); the table lists exactly that and nothing else passes.
func TestGoalImagesRouteTakesOnlyVersionOf(t *testing.T) {
	const p = "/api/board/team-a/goal-images"
	for _, q := range []string{"", "version_of=" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"} {
		assert.Equal(t, TierInteract, Classify("POST", p, q), q)
	}
	for _, q := range []string{"x=1", "board=team-b", "version_of=a&x=1", "Version_Of=a", "path=/etc/passwd"} {
		assert.Equal(t, TierNever, Classify("POST", p, q), q)
	}
}
