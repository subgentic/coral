package devicekey_test

import (
	"crypto/subtle"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
)

// coral-hub's independent vector (internal/pagekit/testdata/reply-mac-vector.json): our reply MAC, the computer fingerprint and the shown fingerprint must all match it.
func TestReplyMACMatchesCoralHubsVector(t *testing.T) {
	raw, err := os.ReadFile("testdata/hub-reply-mac-vector.json")
	require.NoError(t, err)
	var v struct {
		Secret      string `json:"secret"`
		UserCode    string `json:"user_code"`
		PkRaw       string `json:"pk_raw"`
		ComputerPub string `json:"computer_pub"`
		ReplyMac    string `json:"reply_mac"`
		Computer    string `json:"computer"`
		Fingerprint string `json:"fingerprint"`
	}
	require.NoError(t, json.Unmarshal(raw, &v))
	secret, pk, cpub := dec(t, v.Secret), dec(t, v.PkRaw), dec(t, v.ComputerPub)
	require.Len(t, secret, 16)
	require.Len(t, pk, 65)
	require.Len(t, cpub, 32)

	mac := devicekey.ReplyMAC(secret, v.UserCode, pk, cpub)
	assert.Equal(t, v.ReplyMac, b64.EncodeToString(mac))
	assert.True(t, devicekey.VerifyReplyMAC(secret, v.UserCode, pk, cpub, mac))
	bad := append([]byte{}, mac...)
	bad[0] ^= 1
	assert.False(t, devicekey.VerifyReplyMAC(secret, v.UserCode, pk, cpub, bad))
	assert.False(t, devicekey.VerifyReplyMAC(secret, "ABCD-EFGJ", pk, cpub, mac), "binds the user code")
	assert.Equal(t, v.Computer, devicekey.ComputerFingerprint(cpub))
	assert.Equal(t, v.Fingerprint, devicekey.DisplayFingerprint(cpub))
	// the two directions never agree: a reply cannot be turned into a request
	assert.Zero(t, subtle.ConstantTimeCompare(mac, devicekey.PairMAC(secret, v.UserCode, "", pk)))
}

func dec(t *testing.T, s string) []byte {
	t.Helper()
	b, err := b64.DecodeString(s)
	require.NoError(t, err)
	return b
}
