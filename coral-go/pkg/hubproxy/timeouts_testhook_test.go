//go:build hubproxy_testhooks

package hubproxy

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #20055: with the tag, the hook shortens the header limit and the caller puts it back; it cannot lengthen it.
func TestTheHeaderTimeoutHookShortensAndRestores(t *testing.T) {
	restore := SetHeaderTimeoutForTest(250 * time.Millisecond)
	assert.Equal(t, 250*time.Millisecond, headerTimeout)
	restore()
	assert.Equal(t, 30*time.Second, headerTimeout, "restored")
}

func TestTheHeaderTimeoutHookCannotLengthenOrGoBelowTheFloor(t *testing.T) {
	defer SetHeaderTimeoutForTest(time.Hour)()
	assert.Equal(t, 30*time.Second, headerTimeout, "never longer than production")
	r := SetHeaderTimeoutForTest(time.Nanosecond)
	assert.Equal(t, minUploadStallTimeout, headerTimeout, "never under the floor")
	r()
}
