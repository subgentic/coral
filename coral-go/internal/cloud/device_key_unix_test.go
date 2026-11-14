//go:build linux || darwin

package cloud

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16726 item 1, the body: device_pk goes in the bootstrap redeem body and nowhere else: not in the header, not in a ticket exchange (which refuses unknown fields), not when there is none; and what the Hub answers is
// never taken for a key.
func TestTheDeviceKeyGoesInTheBootstrapRedeemBodyOnly(t *testing.T) {
	pk := newDevicePK(t)
	e := newBootEnv(t)
	e.hub.then(e.hub.ok())
	res := e.run(CredentialSource{Value: []byte(goodCred), DevicePK: pk})
	require.Equal(t, BootstrapEnrolled, res.Status, res.Detail)
	r := e.hub.requests()[0]
	require.JSONEq(t, `"`+pk+`"`, string(r.body["device_pk"]))
	require.NotContains(t, r.auth, pk)
	require.NotContains(t, r.query, pk)

	e = newBootEnv(t)
	e.hub.then(e.hub.ok())
	require.Equal(t, BootstrapEnrolled, e.run(CredentialSource{Value: []byte(goodCred)}).Status)
	require.NotContains(t, e.hub.requests()[0].body, "device_pk", "no key: the body is unchanged")

	e = newBootEnv(t)
	res = e.run(CredentialSource{Value: []byte("cht_0123456789abcdefXYZ"), DevicePK: pk})
	require.Equal(t, BootstrapRefused, res.Status, "a ticket exchange takes no device key")
	require.Empty(t, e.hub.requests(), "and nothing was sent")

	e = newBootEnv(t)
	res = e.run(CredentialSource{Value: []byte(goodCred), DevicePK: "not-a-key"})
	require.Equal(t, BootstrapUnsafeFile, res.Status)
	require.Empty(t, e.hub.requests())
	require.NotContains(t, res.Detail, "not-a-key")
}

// #16726 item 1, the file: a regular file, no link, the user's, 0600, in a folder that is theirs, at most 4096 bytes, one P-256 public key; removed after reading, and removed when it holds no key (a hand-off is not
// left lying about); a file the checks refuse is left exactly as it was.
func TestTheDeviceKeyFileIsCheckedReadOnceAndRemoved(t *testing.T) {
	pk := newDevicePK(t)
	p := credFile(t, pk+"\n")
	got, err := ReadDeviceKeyFile(p)
	require.NoError(t, err)
	assert.Equal(t, pk, got)
	assert.NoFileExists(t, p, "removed after reading")

	bad := credFile(t, "this is not a key\n")
	_, err = ReadDeviceKeyFile(bad)
	require.ErrorIs(t, err, ErrBadDeviceKey)
	assert.NoFileExists(t, bad, "removed when invalid too")

	big := credFile(t, pk+"\n"+string(make([]byte, 4100)))
	_, err = ReadDeviceKeyFile(big)
	require.Error(t, err, "over 4096 bytes")
	assert.FileExists(t, big, "refused by the checks: left as it was")

	loose := credFile(t, pk+"\n")
	require.NoError(t, os.Chmod(loose, 0o644))
	_, err = ReadDeviceKeyFile(loose)
	require.Error(t, err, "mode 0644")
	assert.FileExists(t, loose)

	target := credFile(t, pk+"\n")
	link := filepath.Join(t.TempDir(), "key")
	require.NoError(t, os.Symlink(target, link))
	_, err = ReadDeviceKeyFile(link)
	require.Error(t, err, "a link")
	assert.FileExists(t, target, "the link's target is never touched")

	_, err = ReadDeviceKeyFile(filepath.Join(t.TempDir(), "missing"))
	require.Error(t, err)
}

// A bootstrap with a key file reads it before the network, sends the key, and removes it; a bad one stops the start and is removed too.
func TestBootstrapReadsTheDeviceKeyFileBeforeTheNetwork(t *testing.T) {
	pk := newDevicePK(t)
	e := newBootEnv(t)
	e.hub.then(e.hub.ok())
	kf := credFile(t, pk+"\n")
	res := e.run(CredentialSource{Value: []byte(goodCred), DeviceKeyFile: kf})
	require.Equal(t, BootstrapEnrolled, res.Status, res.Detail)
	assert.JSONEq(t, `"`+pk+`"`, string(e.hub.requests()[0].body["device_pk"]))
	assert.NoFileExists(t, kf)

	e = newBootEnv(t)
	kf = credFile(t, "nope\n")
	res = e.run(CredentialSource{Value: []byte(goodCred), DeviceKeyFile: kf})
	require.Equal(t, BootstrapUnsafeFile, res.Status)
	assert.Empty(t, e.hub.requests(), "nothing reached the Hub")
	assert.NoFileExists(t, kf)
}
