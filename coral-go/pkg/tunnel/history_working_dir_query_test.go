package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #10635: the history list's folder filter is working_dir=<path>, a value compared with what the index stored and never opened, so a Hub viewer may send the "~/proj" form it was shown and a path
// outside the home directory; the key is not a file reference (which would refuse both).
func TestHistoryWorkingDirQueryTakesTheFormsAHubViewerWasShown(t *testing.T) {
	allow := AllowRequest(func() Mode { return TierView })
	for _, v := range []string{"%7E%2Fproj", "%2Fsrv%2Fapp", "%7E"} {
		assert.True(t, allow(http.MethodGet, "/api/sessions/history", "type=agent&working_dir="+v), v)
	}
	assert.False(t, allow(http.MethodGet, "/api/sessions/history", "type=agent&folder=%2Fsrv%2Fapp"), "the old key is not read any more")
}
