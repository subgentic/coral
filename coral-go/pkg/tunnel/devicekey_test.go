package tunnel

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #16654 (coral-hub device keys, step 1): the four signature headers are evidence for a later step. The connector carries them only on a write to an owner route, all four together, one value each and
// short; every other request loses them, whatever the spelling; and they never become an identity header.
func deviceSet() http.Header {
	h := http.Header{}
	h.Set(DeviceKeyHeader, "a2V5")
	h.Set(DeviceSigHeader, "c2ln")
	h.Set(DeviceTsHeader, "1763100000")
	h.Set(DeviceNonceHeader, "bm9uY2U")
	return h
}

func hasAnyDevice(h http.Header) bool {
	for k := range h {
		if IsDeviceHeader(k) {
			return true
		}
	}
	return false
}

func TestScrubForwardsTheDeviceHeadersOnlyOnAnOwnerRoutesWrite(t *testing.T) {
	review := "/api/board/team/artifacts/" + strings.Repeat("a", 64) + "/review"
	for _, c := range []struct {
		method, path string
		kept         bool
	}{
		{http.MethodPost, review, true},
		{http.MethodGet, review, false},
		{http.MethodHead, review, false},
		{http.MethodPost, "/api/not-in-the-table", false},
		{http.MethodPost, "/api/sessions/live/x/capture", false},
	} {
		got := scrub(deviceSet(), c.method, c.path)
		assert.Equal(t, c.kept, hasAnyDevice(got), "%s %s", c.method, c.path)
		if c.kept {
			for _, n := range DeviceHeaders {
				assert.Len(t, got[n], 1, n)
			}
		}
	}
}

func TestScrubKeepsOnlyAWholeDeviceSet(t *testing.T) {
	review := "/api/board/team/artifacts/" + strings.Repeat("a", 64) + "/review"
	for name, mutate := range map[string]func(http.Header){
		"a missing name":         func(h http.Header) { h.Del(DeviceNonceHeader) },
		"an empty value":         func(h http.Header) { h.Set(DeviceTsHeader, "") },
		"two values of one name": func(h http.Header) { h.Add(DeviceSigHeader, "c2lnMg") },
		"an oversized value":     func(h http.Header) { h.Set(DeviceKeyHeader, strings.Repeat("A", DeviceHeaderMaxValue+1)) },
	} {
		h := deviceSet()
		mutate(h)
		assert.False(t, hasAnyDevice(scrub(h, http.MethodPost, review)), name+": all four go")
	}
	h := deviceSet()
	h.Set(DeviceKeyHeader, strings.Repeat("A", DeviceHeaderMaxValue))
	assert.True(t, hasAnyDevice(scrub(h, http.MethodPost, review)), "the longest value allowed stays")
}

func TestScrubDeviceHeadersInAnySpellingAndNeverAnIdentity(t *testing.T) {
	review := "/api/board/team/artifacts/" + strings.Repeat("a", 64) + "/review"
	h := http.Header{"coral-device-key": {"a2V5"}, "CORAL-DEVICE-SIG": {"c2ln"}, "Coral-Device-Ts": {"1"}, "coral-device-nonce": {"bg"}}
	assert.True(t, hasAnyDevice(scrub(h, http.MethodPost, review)), "canonicalised, then kept as a whole set")
	assert.False(t, hasAnyDevice(scrub(h, http.MethodGet, review)), "dropped in any spelling when not forwarded")
	got := scrub(deviceSet(), http.MethodPost, review)
	assert.Empty(t, got.Get(HubUserHeader), "never copied into the hub user")
	assert.Empty(t, got.Get("X-Coral-Hub-Guide-Label"))
	for k, vs := range got {
		if !IsDeviceHeader(k) {
			assert.NotContains(t, strings.Join(vs, ","), "a2V5", k+" never carries the key")
		}
	}
	StripDeviceHeaders(h)
	assert.False(t, hasAnyDevice(h), "StripDeviceHeaders removes every spelling")
}
