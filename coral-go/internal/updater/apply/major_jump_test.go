package apply

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #8544: an MSI of the first major release reports 2.0.0 or 2.0.0.0, and one of the old line is not it.
func TestAMajorMSIProductVersionIsTheReleaseVersion(t *testing.T) {
	assert.True(t, msiVersionIs("2.0.0", "2.0.0"))
	assert.True(t, msiVersionIs("2.0.0.0", "2.0.0"))
	assert.False(t, msiVersionIs("1.4.170.0", "2.0.0"))
	assert.False(t, msiVersionIs("2.0.0.1", "2.0.0"))
}
