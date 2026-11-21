package devicekey_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

// Device signing step 4(b) (#20513, coral-hub #260094): every relayed kind that carries a body signs the SHA-256 of the exact body bytes, and the computer checks it. The four step-2 actions stay byte for byte.

func (f fx) relayed(k devicekey.Kind, body string) devicekey.Relayed {
	return devicekey.Relayed{Kind: k, KID: f.signerKID, Computer: f.computer, Ts: 1800000000, Nonce: f.nonce, Link: "lnk_1", HubUser: "hub-user-0a1b2c3d", Method: "POST", Path: "/api/x", BodySHA256: devicekey.BodySHA256([]byte(body))}
}

func TestBodySHA256IsLowerCaseHexOfTheExactBytes(t *testing.T) {
	s := sha256.Sum256([]byte(`{"text":"hi"}`))
	assert.Equal(t, hex.EncodeToString(s[:]), devicekey.BodySHA256([]byte(`{"text":"hi"}`)))
	assert.Len(t, devicekey.BodySHA256(nil), 64)
	assert.NotEqual(t, devicekey.BodySHA256([]byte("a")), devicekey.BodySHA256([]byte("a ")), "one extra byte is another hash")
}

// By hand, so the code is not its own oracle: the keys in their fixed order, then the body hash last.
func TestRelayedCanonicalFormByHand(t *testing.T) {
	f := fixture(t)
	m := f.relayed(devicekey.SendToAgent, "BODY")
	c, err := m.Canonical()
	require.NoError(t, err)
	want := `{"kid":"` + f.signerKID + `","computer":"` + f.computer + `","ts":1800000000,"nonce":"` + f.nonce +
		`","link":"lnk_1","hub_user":"hub-user-0a1b2c3d","method":"POST","path":"/api/x","body_sha256":"` + devicekey.BodySHA256([]byte("BODY")) + `"}`
	assert.Equal(t, want, string(c))
}

func TestRelayedSigningInputNamesTheV3LabelAndTheKind(t *testing.T) {
	in := devicekey.RelayedSigningInput(devicekey.BoardPost, []byte("X"))
	assert.Equal(t, "coral-hub/device-keys/3/board-post\x00X", string(in))
	// a v2 action's input never equals a v3 one for the same body
	assert.NotEqual(t, string(devicekey.SigningInput(devicekey.RaiseMode, []byte("X"))), string(devicekey.RelayedSigningInput(devicekey.Kind("raise-mode"), []byte("X"))))
}

func TestEveryBodyKindParsesBackFromItsCanonicalForm(t *testing.T) {
	f := fixture(t)
	require.NotEmpty(t, devicekey.RelayedKinds)
	for _, k := range devicekey.RelayedKinds {
		c, err := f.relayed(k, "b").Canonical()
		require.NoError(t, err, k)
		m, err := devicekey.ParseRelayed(k, c)
		require.NoError(t, err, k)
		assert.Equal(t, f.relayed(k, "b"), m, k)
	}
	// the kinds
	got := map[devicekey.Kind]bool{}
	for _, k := range devicekey.RelayedKinds {
		got[k] = true
	}
	for _, k := range []string{"guide-roster", "orchestrator-grant", "trust-preview", "daily-knowledge-team", "daily-knowledge-auto-apply", "daily-knowledge-accept", "daily-knowledge-revert", "send-to-agent", "board-post"} {
		assert.True(t, got[devicekey.Kind(k)], k)
	}
}

func TestRelayedRefusesAnythingButTheExactForm(t *testing.T) {
	f := fixture(t)
	good, _ := f.relayed(devicekey.SendToAgent, "b").Canonical()
	hash := devicekey.BodySHA256([]byte("b"))
	for name, bad := range map[string]string{
		"spaces":               strings.Replace(string(good), `"ts":`, `"ts": `, 1),
		"upper-case hash":      strings.Replace(string(good), hash, strings.ToUpper(hash), 1),
		"short hash":           strings.Replace(string(good), hash, hash[:63], 1),
		"non-hex hash":         strings.Replace(string(good), hash, strings.Repeat("g", 64), 1),
		"hash missing":         strings.Replace(string(good), `,"body_sha256":"`+hash+`"`, "", 1),
		"extra key":            strings.Replace(string(good), `}`, `,"x":"y"}`, 1),
		"hash before link":     `{"kid":"` + f.signerKID + `","computer":"` + f.computer + `","ts":1800000000,"nonce":"` + f.nonce + `","body_sha256":"` + hash + `","link":"lnk_1","hub_user":"hub-user-0a1b2c3d"}`,
		"empty link":           strings.Replace(string(good), `"lnk_1"`, `""`, 1),
		"link with a slash":    strings.Replace(string(good), `"lnk_1"`, `"a/b"`, 1),
		"hub_user not a label": strings.Replace(string(good), `hub-user-0a1b2c3d`, `Operator`, 1),
		"hub_user odd length":  strings.Replace(string(good), `hub-user-0a1b2c3d`, `hub-user-0a1b2c3`, 1),
		"hub_user upper-case":  strings.Replace(string(good), `hub-user-0a1b2c3d`, `hub-user-0A1B2C3D`, 1),
		"bad nonce":            strings.Replace(string(good), f.nonce, "short", 1),
		"ts leading zero":      strings.Replace(string(good), `1800000000`, `01800000000`, 1),
		"not an object":        `[]`,
		"trailing bytes":       string(good) + " ",
	} {
		_, err := devicekey.ParseRelayed(devicekey.SendToAgent, []byte(bad))
		assert.ErrorIs(t, err, devicekey.ErrBadForm, name)
	}
	_, err := devicekey.ParseRelayed(devicekey.Kind("raise-mode"), good)
	assert.ErrorIs(t, err, devicekey.ErrBadForm, "a v2 action is not a relayed kind")
	_, err = devicekey.Relayed{Kind: "nope"}.Canonical()
	assert.ErrorIs(t, err, devicekey.ErrBadForm)
}

func TestSixteenHexHubUserLabelsAreAccepted(t *testing.T) {
	f := fixture(t)
	m := f.relayed(devicekey.BoardPost, "b")
	m.HubUser = "hub-user-0123456789abcdef"
	_, err := m.Canonical()
	assert.NoError(t, err)
}

// ---- the verifier ----

func (s signer) signRelayed(t *testing.T, k devicekey.Kind, canonical []byte) string {
	t.Helper()
	h := sha256.Sum256(devicekey.RelayedSigningInput(k, canonical))
	r, ss, err := ecdsa.Sign(rand.Reader, s.priv, h[:])
	require.NoError(t, err)
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	ss.FillBytes(sig[32:])
	return b64.EncodeToString(sig)
}

func (r *rig) relayedMsg(k devicekey.Kind, s signer, body []byte) devicekey.Relayed {
	return devicekey.Relayed{Kind: k, KID: s.kid, Computer: r.computer, Ts: t0.Unix(), Nonce: r.nextNonce(), Link: "lnk_1", HubUser: "hub-user-0a1b2c3d", Method: "POST", Path: "/api/x", BodySHA256: devicekey.BodySHA256(body)}
}

func (r *rig) handleRelayed(m devicekey.Relayed, s signer, body []byte, now time.Time, auth func(devicekey.Relayed, store.DeviceKey) error) (devicekey.Relayed, error) {
	r.t.Helper()
	c, err := m.Canonical()
	require.NoError(r.t, err)
	return r.v.HandleRelayedOn(context.Background(), "lnk_1", "POST", "/api/x", m.Kind, c, body, s.signRelayed(r.t, m.Kind, c), now, auth)
}

func allow(devicekey.Relayed, store.DeviceKey) error { return nil }

func TestRelayedAcceptsTheExactBodyAndSpendsItsNonce(t *testing.T) {
	r := newRig(t)
	body := []byte(`{"text":"run the tests"}`)
	m := r.relayedMsg(devicekey.SendToAgent, r.signer, body)
	got, err := r.handleRelayed(m, r.signer, body, t0, allow)
	require.NoError(t, err)
	assert.Equal(t, m, got)
	_, err = r.handleRelayed(m, r.signer, body, t0, allow) // the same nonce again
	assert.ErrorIs(t, err, devicekey.ErrNonceRepeat)
}

func TestRelayedRefusesABodyThatIsNotTheOneSigned(t *testing.T) {
	r := newRig(t)
	signed := []byte(`{"text":"run the tests"}`)
	for name, other := range map[string][]byte{
		"another text":  []byte(`{"text":"rm -rf ~"}`),
		"one more byte": append(append([]byte{}, signed...), ' '),
		"empty":         nil,
	} {
		m := r.relayedMsg(devicekey.SendToAgent, r.signer, signed)
		_, err := r.handleRelayed(m, r.signer, other, t0, allow)
		assert.ErrorIs(t, err, devicekey.ErrBodyHash, name)
		// nothing was spent: the same nonce with the right body still works
		_, err = r.handleRelayed(m, r.signer, signed, t0, allow)
		assert.NoError(t, err, name)
	}
}

func TestRelayedAuthorityRunsBeforeTheNonceIsSpentAndCanRefuse(t *testing.T) {
	r := newRig(t)
	body := []byte("b")
	m := r.relayedMsg(devicekey.BoardPost, r.signer, body)
	errNo := errors.New("no")
	var seen store.DeviceKey
	_, err := r.handleRelayed(m, r.signer, body, t0, func(_ devicekey.Relayed, k store.DeviceKey) error { seen = k; return errNo })
	assert.ErrorIs(t, err, errNo)
	assert.Equal(t, r.signer.kid, seen.KID, "the signer row comes from the computer's own list")
	_, err = r.handleRelayed(m, r.signer, body, t0, allow)
	assert.NoError(t, err, "a refused message spent no nonce")
	_, err = r.v.HandleRelayedOn(context.Background(), "lnk_1", "POST", "/api/x", devicekey.BoardPost, nil, body, "", t0, nil)
	assert.Error(t, err, "no authority function, no acceptance")
}

func TestRelayedChecksComputerWindowSignerAndSignature(t *testing.T) {
	r := newRig(t)
	body := []byte("b")
	wrongComputer := r.relayedMsg(devicekey.SendToAgent, r.signer, body)
	wrongComputer.Computer = r.relayedMsg(devicekey.SendToAgent, newSigner(t), body).KID // any other 43-char value
	_, err := r.handleRelayed(wrongComputer, r.signer, body, t0, allow)
	assert.ErrorIs(t, err, devicekey.ErrWrongComputer)

	stranger := newSigner(t)
	_, err = r.handleRelayed(r.relayedMsg(devicekey.SendToAgent, stranger, body), stranger, body, t0, allow)
	assert.ErrorIs(t, err, devicekey.ErrUnknownSigner)

	forged := r.relayedMsg(devicekey.SendToAgent, r.signer, body)
	c, _ := forged.Canonical()
	_, err = r.v.HandleRelayedOn(context.Background(), "lnk_1", "POST", "/api/x", forged.Kind, c, body, stranger.signRelayed(t, forged.Kind, c), t0, allow)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature)

	// the clock only moves forward, so the window cases come last
	_, err = r.handleRelayed(r.relayedMsg(devicekey.SendToAgent, r.signer, body), r.signer, body, t0.Add(5*time.Minute), allow)
	assert.NoError(t, err)
	old := r.relayedMsg(devicekey.SendToAgent, r.signer, body)
	_, err = r.handleRelayed(old, r.signer, body, t0.Add(5*time.Minute+time.Second), allow)
	assert.ErrorIs(t, err, devicekey.ErrTsWindow, "five minutes for every relayed kind, not the day a v2 remove allows")
}

func TestARelayedSignatureIsNotAnotherKindsAndNotAV2Actions(t *testing.T) {
	r := newRig(t)
	body := []byte("b")
	m := r.relayedMsg(devicekey.SendToAgent, r.signer, body)
	c, _ := m.Canonical()
	// signed as board-post, presented as send-to-agent
	_, err := r.v.HandleRelayedOn(context.Background(), "lnk_1", "POST", "/api/x", devicekey.SendToAgent, c, body, r.signer.signRelayed(t, devicekey.BoardPost, c), t0, allow)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature)
	// the same canonical bytes signed under the v2 label
	_, err = r.v.HandleRelayedOn(context.Background(), "lnk_1", "POST", "/api/x", devicekey.SendToAgent, c, body, r.signer.sign(t, devicekey.RaiseMode, c), t0, allow)
	assert.ErrorIs(t, err, devicekey.ErrBadSignature)
}

func TestRelayedSignedByAPasskeyIsRefused(t *testing.T) {
	r := newRig(t)
	pk := newSigner(t)
	r.add(pk, "view", store.DeviceOriginPairing, store.DeviceKindPasskey)
	body := []byte("b")
	_, err := r.handleRelayed(r.relayedMsg(devicekey.SendToAgent, pk, body), pk, body, t0, allow)
	assert.ErrorIs(t, err, devicekey.ErrUnknownSigner)
}

func TestRelayedHonoursRefuseAndBeforeStart(t *testing.T) {
	r := newRig(t)
	body := []byte("b")
	r.v.Refuse = func() bool { return true }
	_, err := r.handleRelayed(r.relayedMsg(devicekey.SendToAgent, r.signer, body), r.signer, body, t0, allow)
	assert.ErrorIs(t, err, devicekey.ErrListUnavailable)
	r.v.Refuse = nil
	r.v.SetRefuseBefore(t0.Add(time.Minute))
	_, err = r.handleRelayed(r.relayedMsg(devicekey.SendToAgent, r.signer, body), r.signer, body, t0.Add(time.Second), allow)
	assert.ErrorIs(t, err, devicekey.ErrBeforeStart)
}

func TestRelayedRefusesAnotherMethodOrPathThanTheOneReceived(t *testing.T) {
	r := newRig(t)
	body := []byte("b")
	m := r.relayedMsg(devicekey.SendToAgent, r.signer, body)
	c, _ := m.Canonical()
	sig := r.signer.signRelayed(t, m.Kind, c)
	for _, x := range []struct{ method, path string }{{"PUT", "/api/x"}, {"POST", "/api/y"}, {"POST", "/api/x?a=1"}} {
		_, err := r.v.HandleRelayedOn(context.Background(), "lnk_1", x.method, x.path, m.Kind, c, body, sig, t0, allow)
		assert.ErrorIs(t, err, devicekey.ErrWrongRequest, x.method+" "+x.path)
	}
	_, err := r.v.HandleRelayedOn(context.Background(), "lnk_1", "POST", "/api/x", m.Kind, c, body, sig, t0, allow)
	assert.NoError(t, err, "nothing was spent by the refusals")
}

func TestRelayedBodiesAreCappedAndABodylessKindSignsTheEmptyHash(t *testing.T) {
	r := newRig(t)
	big := make([]byte, devicekey.RelayedBodyMax+1)
	m := r.relayedMsg(devicekey.SendToAgent, r.signer, big)
	_, err := r.handleRelayed(m, r.signer, big, t0, allow)
	assert.ErrorIs(t, err, devicekey.ErrBodyTooLarge)
	assert.Equal(t, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", devicekey.BodySHA256(nil))
	for _, k := range []devicekey.Kind{devicekey.GrantMember, devicekey.InputGrant, devicekey.KeepFullAccess, devicekey.HubAutoAccept} {
		m := r.relayedMsg(k, r.signer, nil)
		_, err := r.handleRelayed(m, r.signer, nil, t0, allow)
		assert.NoError(t, err, k)
		m = r.relayedMsg(k, r.signer, nil)
		_, err = r.handleRelayed(m, r.signer, []byte("x"), t0, allow)
		assert.ErrorIs(t, err, devicekey.ErrBodyHash, "one byte where none was signed: %s", k)
	}
}
