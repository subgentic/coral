package verify

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8544: the staged update of the first major release is accepted and orders above every 1.x one.
func TestAMajorVersionOrdersAboveEveryMinorOfThePreviousOne(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"1.4.170", "2.0.0", -1},
		{"2.0.0", "1.4.170", 1},
		{"1.999.9999", "2.0.0", -1}, // the largest 1.x the pattern allows
		{"2.0.0", "2.0.1", -1},
		{"2.0.0", "2.0.0", 0},
		{"9.9.9", "10.0.0", -1},
	} {
		got, err := CompareVersions(c.a, c.b)
		require.NoError(t, err, "%s %s", c.a, c.b)
		assert.Equal(t, c.want, got, "CompareVersions(%q, %q)", c.a, c.b)
	}
	v, err := ParseVersion("2.0.0")
	require.NoError(t, err)
	assert.Equal(t, [3]int{2, 0, 0}, v)
	_, err = ParseVersion("v2.0.0")
	assert.Error(t, err, "callers strip the tag's v")
}
