package stage

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #8544: the promote tag of the first major release.
func TestAPromoteTagForAMajorVersion(t *testing.T) {
	m := promoteTagRe.FindStringSubmatch("promote-v2.0.0-1761500000")
	if assert.NotNil(t, m) {
		assert.Equal(t, "v2.0.0", m[1])
		assert.Equal(t, "1761500000", m[2])
	}
	assert.Nil(t, promoteTagRe.FindStringSubmatch("promote-2.0.0-1761500000"), "the version keeps its v")
}
