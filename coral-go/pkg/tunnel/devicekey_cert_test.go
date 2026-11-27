package tunnel

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Sign once (#21889): Coral-Device-Cert and Coral-Device-Revoke cross only beside the four device headers, one non-empty value each, at most DeviceCertHeaderMax bytes, and only on the routes of ForwardsDeviceHeaders.
func four() http.Header {
	h := http.Header{}
	h.Set(DeviceKeyHeader, "k")
	h.Set(DeviceSigHeader, "s")
	h.Set(DeviceTsHeader, "1")
	h.Set(DeviceNonceHeader, "n")
	return h
}

func TestTheCertHeadersStayOnlyBesideAWholeSetAsOneBoundedValue(t *testing.T) {
	h := four()
	h.Set(DeviceCertHeader, "cert")
	h.Set(DeviceRevokeHeader, "rev")
	keepWholeDeviceSet(h)
	assert.Equal(t, "cert", h.Get(DeviceCertHeader))
	assert.Equal(t, "rev", h.Get(DeviceRevokeHeader))

	h = four()
	h.Add(DeviceCertHeader, "a")
	h.Add(DeviceCertHeader, "b") // a smuggled second certificate
	keepWholeDeviceSet(h)
	assert.Empty(t, h.Values(DeviceCertHeader), "a repeated header is dropped, the four stay")
	assert.Equal(t, "k", h.Get(DeviceKeyHeader))

	h = four()
	h.Set(DeviceCertHeader, strings.Repeat("a", DeviceCertHeaderMax+1))
	h.Set(DeviceRevokeHeader, strings.Repeat("a", DeviceCertHeaderMax))
	keepWholeDeviceSet(h)
	assert.Empty(t, h.Get(DeviceCertHeader), "over the cap")
	assert.NotEmpty(t, h.Get(DeviceRevokeHeader), "exactly the cap stays")

	h = four()
	h.Set(DeviceCertHeader, "")
	keepWholeDeviceSet(h)
	assert.Empty(t, h.Values(DeviceCertHeader), "never empty")

	h = http.Header{}
	h.Set(DeviceCertHeader, "cert") // no device headers beside it
	h.Set(DeviceKeyHeader, "k")     // a half set
	keepWholeDeviceSet(h)
	assert.Empty(t, h.Get(DeviceCertHeader))
}

func TestTheCertHeadersAreDeviceHeadersSoTheyAreStrippedWhereverTheFourAre(t *testing.T) {
	assert.True(t, IsDeviceHeader("coral-device-cert"))
	assert.True(t, IsDeviceHeader("CORAL-DEVICE-REVOKE"))
	h := four()
	h.Set(DeviceCertHeader, "c")
	StripDeviceHeaders(h)
	assert.Empty(t, h)
	assert.False(t, DeviceHeaderMayStay(DeviceCertHeader, "GET", "/api/sessions"), "never on a read")
	assert.True(t, DeviceHeaderMayStay(DeviceCertHeader, "POST", "/api/sessions/live/x/send"))
}

func TestTheCapabilityWordIsOwnerCertOne(t *testing.T) { assert.Equal(t, "owner_cert/1", CapOwnerCert) }
