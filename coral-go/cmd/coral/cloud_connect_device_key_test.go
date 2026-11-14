package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16726: --device-key-file goes with --ticket-file. The command line reads the file (the user's, 0600, a P-256 public key), removes it, and sends the PUBLIC key as device_pk in the redeem body: never a path, never in a
// header. A file that holds no key stops the command before the credential is read, and is removed too; without the flag the body is unchanged.
func TestCloudConnectDeviceKeyFile(t *testing.T) {
	unixOnly(t)
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	require.NoError(t, err)
	pk := base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes())

	f := newFakeCoral(t, ready, enrolled)
	ticket := secretFile(t, "ticket", testCred+"\n")
	key := secretFile(t, "device.pub", pk+"\n")
	var out, errb bytes.Buffer
	code := runCloud([]string{"connect", "--ticket-file", ticket, "--device-key-file", key, "--url", f.srv.URL}, nil, &out, &errb)
	require.Equal(t, 0, code, errb.String())
	require.Len(t, f.redeems, 1)
	assert.JSONEq(t, `"`+pk+`"`, string(f.redeems[0].body["device_pk"]))
	assert.NotContains(t, f.redeems[0].body, "device_key_file")
	assert.NotContains(t, f.redeems[0].auth, pk)
	assert.NoFileExists(t, key, "removed after reading")
	assert.NoFileExists(t, ticket)

	f2 := newFakeCoral(t, ready, enrolled)
	ticket = secretFile(t, "ticket", testCred+"\n")
	require.Equal(t, 0, runCloud([]string{"connect", "--ticket-file", ticket, "--url", f2.srv.URL}, nil, &out, &errb))
	assert.NotContains(t, f2.redeems[0].body, "device_pk", "no flag: the body is unchanged")

	f3 := newFakeCoral(t, ready, enrolled)
	ticket = secretFile(t, "ticket", testCred+"\n")
	bad := secretFile(t, "device.pub", "not a key\n")
	errb.Reset()
	assert.Equal(t, 2, runCloud([]string{"connect", "--ticket-file", ticket, "--device-key-file", bad, "--url", f3.srv.URL}, nil, &out, &errb))
	assert.Empty(t, f3.redeems, "nothing was sent")
	assert.FileExists(t, ticket, "the credential was not read")
	assert.NoFileExists(t, bad, "a file that holds no key is removed")
	assert.NotContains(t, errb.String(), "not a key")

	assert.Equal(t, 2, runCloud([]string{"connect", "--device-key-file", "k"}, nil, &out, &errb), "--device-key-file needs --ticket-file")
}
