package updatecheck

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8544: the release after 1.4.x is 2.0.0. Every comparison and shape check this package makes is by number, so a major release is above every 1.x one and passes each shape.
func TestAMajorReleaseIsOfferedToEveryMinorOfThePreviousOne(t *testing.T) {
	for _, c := range []struct {
		latest, current string
		want            bool
	}{
		{"2.0.0", "1.4.170", true},
		{"v2.0.0", "v1.4.170", true},
		{"2.0.0", "1.999.99999", true},
		{"1.4.171", "2.0.0", false}, // a 2.0.0 install is never told to go back
		{"1.9.9", "2.0.0", false},
		{"2.0.0", "2.0.0", false},
		{"2.0.1", "2.0.0", true},
		{"2.0.0", "2.0.0-rc.1", true},          // its release is newer than its candidate
		{"2.0.0", "2.0.1-dev+8f406dae", false}, // a dev build of the next patch
		{"10.0.0", "9.9.9", true},              // not a string comparison
	} {
		assert.Equal(t, c.want, Newer(c.latest, c.current), "Newer(%q, %q)", c.latest, c.current)
	}
}

func TestAMajorTagPassesEveryShapeCheckAndHasItsPage(t *testing.T) {
	for _, v := range []string{"2.0.0", "v2.0.0", "2.0.0-rc.1", "10.0.0"} {
		assert.True(t, ValidVersion(v), v)
	}
	assert.True(t, stableTag.MatchString("v2.0.0"), "the approved channel's tag shape")
	assert.Equal(t, ReleasesURL+"/tag/v2.0.0", ReleasePageURL(Agentic, "2.0.0"))
	assert.Equal(t, ReleasesURL+"/tag/v2.0.0", ReleasePageURL(Agentic, "v2.0.0"))

	v, err := Latest(context.Background(), serve(t, 200, tag("v2.0.0")))
	require.NoError(t, err)
	assert.Equal(t, "2.0.0", v)
	v, err = Available(context.Background(), serve(t, 200, tag("v2.0.0")), "1.4.170")
	require.NoError(t, err)
	assert.Equal(t, "2.0.0", v, "a 1.4.170 install is offered 2.0.0")
}
