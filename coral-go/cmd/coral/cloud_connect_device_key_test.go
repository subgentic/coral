package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"regexp"
	"strings"
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

// Slice 4: the link `coral cloud connect` prints carries the pairing secret in its fragment (#p=), made here and handed to this Coral in the body of the connect call only. The fragment never reaches the Hub (a browser does not send it),
// and the secret is not in the process arguments.
func TestCloudConnectPrintsTheLinkWithTheSecretAndSendsItOnlyInTheBody(t *testing.T) {
	fastPoll(t)
	f := newFakeCoral(t, ready, enrolled)
	f.statuses = []string{idle, enrolling, enrolling, connected}
	var out, errb bytes.Buffer
	args := []string{"connect", "--url", f.srv.URL}
	require.Equal(t, 0, runCloud(args, strings.NewReader(""), &out, &errb), errb.String())
	m := regexp.MustCompile(`open (\S+)#p=([A-Za-z0-9_-]{22}) and enter code ABCD-EFGH\n`).FindStringSubmatch(out.String())
	require.NotNil(t, m, out.String())
	assert.Equal(t, "https://app.coralhub.dev/enroll?code=ABCD-EFGH", m[1])
	secret := m[2]
	var connectCalls, other []string
	for _, c := range f.callList() {
		if strings.HasPrefix(c, "POST /api/cloud/connect ") {
			connectCalls = append(connectCalls, c)
		} else if strings.Contains(c, secret) {
			other = append(other, c)
		}
	}
	require.Len(t, connectCalls, 1)
	assert.Contains(t, connectCalls[0], `"pairing_secret":"`+secret+`"`)
	assert.Empty(t, other, "no other request carries the secret")
	assert.NotContains(t, strings.Join(args, " "), secret, "not in the arguments")
	assert.NotContains(t, errb.String(), secret)
}
