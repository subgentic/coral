package stage

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func feedList(tags ...string) []listedRelease {
	var out []listedRelease
	for _, t := range tags {
		out = append(out, listedRelease{TagName: t, fromFeed: true})
	}
	return out
}

// The shortcut compares the feed's product tags with the installed version and is closed on anything it cannot compare: an installed version that is not X.Y.Z (a dev build, a prerelease build, nothing)
// is never "up to date" from a feed (Security Reviewer's SHOULD on #9719). stage.Check itself refuses such a version before any request (installed_version); this is the second lock on the same door.
func TestFeedNothingNewerIsNotConcludedForAnInstalledVersionThatCannotBeCompared(t *testing.T) {
	normal := feedList("v1.4.131", "v1.4.130", "v1.4.129")
	for _, installed := range []string{"", "dev", "1.4", "1.4.130-rc1", "v1.4.130", "1.4.130 ", "latest", "1.4.x"} {
		assert.False(t, feedNothingNewer(normal, installed), "installed %q cannot be compared: the API's list is asked", installed)
		assert.False(t, feedNothingNewer(feedList("v1.4.100"), installed), "even a feed with only old tags: installed %q", installed)
	}
	// and with a version that compares, the same feeds decide
	assert.False(t, feedNothingNewer(normal, "1.4.130"), "1.4.131 is newer")
	assert.True(t, feedNothingNewer(normal, "1.4.131"), "nothing newer")
	assert.True(t, feedNothingNewer(normal, "1.5.0"), "installed ahead")
	assert.False(t, feedNothingNewer(feedList(), "1.4.130"), "an empty feed cannot say")
	assert.False(t, feedNothingNewer(feedList("v1.4.131-rc1", "nightly"), "1.4.130"), "no product tag cannot say")
}
