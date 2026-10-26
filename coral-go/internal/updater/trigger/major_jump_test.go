package trigger

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #8544: a staged update of 2.0.0 is a version folder the installer accepts.
func TestAStagedMajorVersionIsAcceptable(t *testing.T) {
	for _, v := range []string{"2.0.0", "1.4.170", "10.0.0", "2.0.1234"} {
		assert.True(t, stagedVersionRe.MatchString(v), v)
	}
	for _, v := range []string{"v2.0.0", "2.0", "2.0.0.0", "2.0.0-rc1", "1000.0.0", "2.0.12345"} {
		assert.False(t, stagedVersionRe.MatchString(v), v)
	}
}
