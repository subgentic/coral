package devicekey_test

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
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

func pairingFixture(t *testing.T) (secret []byte, userCode, label string, s signer, ans devicekey.PairingAnswer) {
	t.Helper()
	secret = []byte("0123456789abcdef")
	userCode, label = "ABCD-EFGH", "My laptop"
	s = newSigner(t)
	pk := dec(t, s.pk)
	ans = devicekey.PairingAnswer{V: 1, KID: s.kid, MAC: b64.EncodeToString(devicekey.PairMAC(secret, userCode, label, pk)), UserCode: userCode, PK: s.pk}
	return
}

func TestCheckPairingAcceptsAGoodAnswerAndReturnsTheKey(t *testing.T) {
	secret, uc, label, s, ans := pairingFixture(t)
	pk, err := devicekey.CheckPairing(secret, uc, label, ans)
	require.NoError(t, err)
	assert.Equal(t, dec(t, s.pk), pk)
}

func TestCheckPairingRefusals(t *testing.T) {
	secret, uc, label, s, good := pairingFixture(t)
	other := newSigner(t)
	for name, tc := range map[string]struct {
		secret []byte
		uc     string
		label  string
		mut    func(a *devicekey.PairingAnswer)
		want   error
	}{
		"no pk":        {secret, uc, label, func(a *devicekey.PairingAnswer) { a.PK = "" }, devicekey.ErrPairingNoKey},
		"wrong secret": {[]byte("fedcba9876543210"), uc, label, func(a *devicekey.PairingAnswer) {}, devicekey.ErrPairingMAC},
		"own user code is the input, not the echoed one": {secret, "WXYZ-ABCD", label, func(a *devicekey.PairingAnswer) {}, devicekey.ErrPairingMAC},
		"swapped label":            {secret, uc, "Other", func(a *devicekey.PairingAnswer) {}, devicekey.ErrPairingMAC},
		"swapped key, kid follows": {secret, uc, label, func(a *devicekey.PairingAnswer) { a.PK, a.KID = other.pk, other.kid }, devicekey.ErrPairingMAC},
		"kid not of pk":            {secret, uc, label, func(a *devicekey.PairingAnswer) { a.KID = other.kid }, devicekey.ErrPairingMAC},
		"pk not a point":           {secret, uc, label, func(a *devicekey.PairingAnswer) { a.PK = s.pk[:80] + "AAAAAAA" }, devicekey.ErrPairingMAC},
		"short mac":                {secret, uc, label, func(a *devicekey.PairingAnswer) { a.MAC = a.MAC[:42] }, devicekey.ErrPairingMAC},
		"wrong v":                  {secret, uc, label, func(a *devicekey.PairingAnswer) { a.V = 2 }, devicekey.ErrPairingMAC},
		"no secret held":           {nil, uc, label, func(a *devicekey.PairingAnswer) {}, devicekey.ErrPairingNoSecret},
	} {
		a := good
		tc.mut(&a)
		pk, err := devicekey.CheckPairing(tc.secret, tc.uc, tc.label, a)
		assert.ErrorIs(t, err, tc.want, name)
		assert.Nil(t, pk, name)
	}
}

// The compare is constant time (a source check, design page section 7).
func TestPairingMACCompareIsConstantTime(t *testing.T) {
	src, err := os.ReadFile("pairing.go")
	require.NoError(t, err)
	assert.Contains(t, string(src), "hmac.Equal(")
	assert.NotContains(t, string(src), "bytes.Equal(")
	assert.NotContains(t, string(src), "== mac")
}

func TestNewPairingSecretIs22CharactersOf16RandomBytes(t *testing.T) {
	a, b := devicekey.NewPairingSecret(), devicekey.NewPairingSecret()
	assert.Len(t, a, 22)
	assert.NotEqual(t, a, b)
	raw, ok := devicekey.ParsePairingSecret(a)
	require.True(t, ok)
	assert.Len(t, raw, 16)
	for _, bad := range []string{"", a[:21], a + "A", strings.Repeat("!", 22)} {
		_, ok := devicekey.ParsePairingSecret(bad)
		assert.False(t, ok, bad)
	}
}

func TestCompletePairingAddsADeviceAtTheWebMode(t *testing.T) {
	r := newRig(t)
	secret, uc, label, s, ans := pairingFixture(t)
	kid, err := devicekey.CompletePairing(context.Background(), r.ss, secret, uc, label, ans, "launch", t0)
	require.NoError(t, err)
	assert.Equal(t, s.kid, kid)
	k, ok := r.listed(s.kid)
	require.True(t, ok)
	assert.Equal(t, store.DeviceOriginPairing, k.Origin)
	assert.Equal(t, "launch", k.Mode)
	assert.Equal(t, label, k.Label)
	assert.Equal(t, store.DeviceKindDevice, k.Kind)
}

func TestCompletePairingStoresNothingWhenARefusalComes(t *testing.T) {
	r := newRig(t)
	secret, uc, label, s, ans := pairingFixture(t)
	ans.MAC = b64.EncodeToString(make([]byte, 32))
	_, err := devicekey.CompletePairing(context.Background(), r.ss, secret, uc, label, ans, "launch", t0)
	assert.ErrorIs(t, err, devicekey.ErrPairingMAC)
	_, ok := r.listed(s.kid)
	assert.False(t, ok)
	// a label outside the shared rule is refused too, before anything is stored
	good := ans
	good.MAC = b64.EncodeToString(devicekey.PairMAC(secret, uc, "  padded ", dec(t, s.pk)))
	_, err = devicekey.CompletePairing(context.Background(), r.ss, secret, uc, "  padded ", good, "launch", t0)
	assert.Error(t, err)
	_, ok = r.listed(s.kid)
	assert.False(t, ok)
}

// A bootstrap key that the person then pairs for real is promoted; it is the only way up.
func TestCompletePairingPromotesABootstrapKey(t *testing.T) {
	r := newRig(t)
	secret, uc, label, s, ans := pairingFixture(t)
	r.add(s, "view", store.DeviceOriginBootstrap, store.DeviceKindDevice)
	_, err := devicekey.CompletePairing(context.Background(), r.ss, secret, uc, label, ans, "launch", t0)
	require.NoError(t, err)
	k, _ := r.listed(s.kid)
	assert.Equal(t, store.DeviceOriginPairing, k.Origin)
	assert.Equal(t, "view", k.Mode, "the mode it already had is not changed by a promotion")
}

// Only the pairing-proof path reaches the promotion: no other non-test file calls it.
func TestOnlyThePairingPathCallsPromoteDeviceOrigin(t *testing.T) {
	var hits []string
	root := filepath.Join("..", "..")
	require.NoError(t, filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		sl := filepath.ToSlash(p)
		if strings.HasSuffix(sl, "internal/store/device_keys.go") || strings.HasSuffix(sl, "internal/devicekey/pairing.go") {
			return nil
		}
		if b, _ := os.ReadFile(p); strings.Contains(string(b), "PromoteDeviceOrigin") {
			hits = append(hits, p)
		}
		return nil
	}))
	assert.Empty(t, hits)
	// and the verifier's own store interface cannot reach it
	src, _ := os.ReadFile("verify.go")
	assert.NotContains(t, string(src), "PromoteDeviceOrigin")
}

// Wire format section 9: the secret is single use, dead after 10 minutes, the first success or the third failed check (a bad pk counts as a failed MAC).
func TestSecretHoldDiesOnTheThirdFailureTheFirstSuccessOrTenMinutes(t *testing.T) {
	r := newRig(t)
	secret, uc, label, s, good := pairingFixture(t)
	bad := good
	bad.MAC = b64.EncodeToString(make([]byte, 32))
	complete := func(h *devicekey.SecretHold, a devicekey.PairingAnswer, now time.Time) error {
		_, err := h.Complete(context.Background(), r.ss, uc, label, a, "launch", now)
		return err
	}
	h := devicekey.NewSecretHold(secret, t0)
	assert.ErrorIs(t, complete(h, bad, t0), devicekey.ErrPairingMAC)
	badPK := good
	badPK.PK = s.pk[:80] + "AAAAAAA"
	assert.ErrorIs(t, complete(h, badPK, t0), devicekey.ErrPairingMAC, "a bad pk counts too")
	noKey := good
	noKey.PK = ""
	assert.ErrorIs(t, complete(h, noKey, t0), devicekey.ErrPairingNoKey, "no pk is not a failed check")
	assert.ErrorIs(t, complete(h, bad, t0), devicekey.ErrPairingMAC, "the third failure")
	assert.ErrorIs(t, complete(h, good, t0), devicekey.ErrPairingNoSecret, "the secret is dead: even a good answer is refused")
	_, ok := r.listed(s.kid)
	assert.False(t, ok)

	h = devicekey.NewSecretHold(secret, t0)
	assert.ErrorIs(t, complete(h, good, t0.Add(10*time.Minute+time.Second)), devicekey.ErrPairingNoSecret, "dead after ten minutes")
	h = devicekey.NewSecretHold(secret, t0)
	require.NoError(t, complete(h, good, t0.Add(10*time.Minute)))
	assert.ErrorIs(t, complete(h, good, t0), devicekey.ErrPairingNoSecret, "single use: the first success kills it")
	assert.False(t, devicekey.NewSecretHold(nil, t0).Alive(t0))
}
