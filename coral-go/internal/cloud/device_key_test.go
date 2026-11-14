package cloud

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// #16726 item 4: the poll answer may carry pairing{v, kid, mac, user_code} (never pk). Step 1 parses and ignores it: the enrollment completes exactly as without it, and nothing of it is kept.
func TestThePollsPairingObjectIsToleratedAndIgnored(t *testing.T) {
	for name, extra := range map[string]string{
		"the exact shape":          `,"pairing":{"v":1,"kid":"k1","mac":"bWFj","user_code":"ABCD-EFGH"}`,
		"an unknown field":         `,"pairing":{"v":1,"kid":"k1","mac":"bWFj","user_code":"ABCD-EFGH","later":{"x":[1,2]}},"another":true`,
		"a version we do not know": `,"pairing":{"v":9,"kid":7}`,
		"not an object":            `,"pairing":"x"`,
		"null":                     `,"pairing":null`,
	} {
		url, hc := hubWith(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"server_token":"coralhub_srv_abcd1234_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","server_id":"srv_1","label":"L"` + extra + `}`))
		})
		en, err := PollEnrollment(context.Background(), hc, url, "dev")
		require.NoError(t, err, name)
		require.Equal(t, "srv_1", en.ServerID, name)
		require.NotContains(t, fmt.Sprintf("%+v", en), "bWFj", name+": the pairing is not kept")
	}
}

// #16726 item 3: the link's #p= secret is the person's and the Hub page's. A hub that puts it in the verification link, or anywhere in its answers, does not get it into the status, the stored enrolment or a log, and the
// link Coral shows falls back to the hub's own /enroll page (a fragment is never trusted).
func TestThePSecretOfTheLinkIsNeverShownStoredOrLogged(t *testing.T) {
	const secret = "p-secret-Zk3Qv9wXy7LmN2aB5cD8eF1gH4jK6"
	e := newEnv(t)
	e.hub.verifyEnd.Store("#p=" + secret)
	e.hub.pairing.Store(map[string]any{"v": 1, "kid": "k1", "mac": "bWFj", "user_code": "ABCD-EFGH"})
	m := e.manager(e.hub.srv.URL)
	start(t, m)
	require.NoError(t, m.Connect(context.Background()))
	st := m.Status()
	require.Equal(t, StateEnrolling, st.State)
	require.Equal(t, e.hub.srv.URL+"/enroll", st.VerificationURL, "a link with a fragment is replaced by the hub's own page")
	require.NotContains(t, mustJSON(st), secret, "status")
	waitState(t, m, StateConnected)
	st = m.Status()
	require.NotContains(t, mustJSON(st), secret, "status, connected")
	conn, err := e.cs.Get(context.Background())
	require.NoError(t, err)
	require.NotContains(t, fmt.Sprintf("%+v", conn), secret, "the stored enrolment")
	require.NotContains(t, e.logs.String(), secret, "the log")
	require.NotContains(t, e.logs.String(), "bWFj", "the log: no pairing either")
}

func newDevicePK(t *testing.T) string {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	require.NoError(t, err)
	return base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes())
}

// #16726 item 1, the key: P-256 only, the raw 65-byte uncompressed point, base64url without padding, one line, on the curve. Nothing else is a device key, and an error never carries the content.
func TestAcceptsOnlyOneP256PublicKey(t *testing.T) {
	pk := newDevicePK(t)
	require.Len(t, pk, 87)
	for _, in := range []string{pk, pk + "\n", "  " + pk + "\r\n"} {
		got, err := ParseDeviceKey([]byte(in))
		require.NoError(t, err)
		require.Equal(t, pk, got)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(pk)
	off := append([]byte{}, raw...)
	off[40] ^= 0xff // 65 bytes, 0x04, but not a point on the curve
	compressed := append([]byte{0x02}, raw[1:33]...)
	ed := make([]byte, 32)
	for name, bad := range map[string]string{
		"empty": "", "two lines": pk + "\n" + pk, "padded": pk + "=", "standard base64": strings.NewReplacer("-", "+", "_", "/").Replace(pk) + "=",
		"hex": hex.EncodeToString(raw), "not on the curve": base64.RawURLEncoding.EncodeToString(off), "compressed point": base64.RawURLEncoding.EncodeToString(compressed),
		"wrong prefix": base64.RawURLEncoding.EncodeToString(append([]byte{0x05}, raw[1:]...)), "an ed25519-sized key": base64.RawURLEncoding.EncodeToString(ed),
		"a private scalar": base64.RawURLEncoding.EncodeToString(raw[1:33]), "a PEM": "-----BEGIN PUBLIC KEY-----\n" + pk + "\n-----END PUBLIC KEY-----", "junk": "chb_" + pk,
	} {
		_, err := ParseDeviceKey([]byte(bad))
		require.ErrorIs(t, err, ErrBadDeviceKey, name)
		require.NotContains(t, err.Error(), pk[:20], name)
	}
	kid := DeviceKeyID(pk)
	sum := sha256.Sum256(raw)
	require.Equal(t, base64.RawURLEncoding.EncodeToString(sum[:]), kid, "kid = b64url(SHA-256(raw public key))")
}

// #16726 item 2: until Coral does its part of the key beyond handing it over (step 2), the handshake never says device_key/1, whatever was redeemed (the Hub's ruling: only when the key exists and steps 1 and 2 are built).
func TestTheManagerDoesNotOfferDeviceKeyUntilStepTwoIsBuilt(t *testing.T) {
	e := newEnv(t)
	m := e.manager(e.hub.srv.URL)
	require.False(t, m.offersDeviceKey(), "no key")
	pk := newDevicePK(t)
	m.devicePK.Store(&pk)
	require.Equal(t, deviceKeyStepsBuilt, m.offersDeviceKey(), "a key alone is not enough")
	require.False(t, deviceKeyStepsBuilt, "when step 2 lands, this pin and the capability go together")
}
