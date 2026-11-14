package tunnel

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16726 item 2: the name is exactly "device_key/1" (singular, agreed with coral-hub), said in the Hello only when the connector's DeviceKey says so; by default it is not.
func TestTheHelloSaysDeviceKeyOnlyWhenTheConnectorOffersIt(t *testing.T) {
	assert.Equal(t, "device_key/1", CapDeviceKey)
	for name, offer := range map[string]func() bool{"not set": nil, "false": func() bool { return false }, "true": func() bool { return true }} {
		hub := newHub(t, fastCfg())
		ls := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
		t.Cleanup(ls.Close)
		cs, err := Dial(context.Background(), hub.URL(), testToken, ClientOptions{
			SessionConfig: hub.Cfg, Handler: &LocalHandler{BaseURL: ls.URL, AllowPath: allowAll}, CoralVersion: "test", AllowInsecure: true, DeviceKey: offer,
		})
		require.NoError(t, err, name)
		t.Cleanup(func() { cs.Close() })
		sess := hub.next(t)
		assert.Equal(t, offer != nil && offer(), sess.HasPeerCapability(CapDeviceKey), name)
		assert.True(t, sess.HasPeerCapability(CapGuideRole), name+": the others are unchanged")
	}
}
