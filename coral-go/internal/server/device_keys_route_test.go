package server

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/big"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The device-signed routes (#19669 slice 7, wire format draft 11): what a trusted browser signed arrives unstamped through the Hub; the signature is the only authority.

var rb64 = base64.RawURLEncoding

type dkRig struct {
	t      *testing.T
	r      *e2eRemote
	ss     *store.SessionStore
	m      *cloud.Manager
	cf     *failClear
	key    *devicekey.ComputerKey
	logs   *bytes.Buffer
	signer *ecdsa.PrivateKey
	kid    string
	nonce  int
}

type failClear struct {
	*store.SessionStore
	fail bool
}

func (f *failClear) RemoveAllDeviceKeys(ctx context.Context, now time.Time) (int, error) {
	if f.fail {
		return 0, assert.AnError
	}
	return f.SessionStore.RemoveAllDeviceKeys(ctx, now)
}

func newDKRig(t *testing.T) *dkRig {
	t.Helper()
	r := newE2ERemote(t, "dk-route", nil)
	ss := store.NewSessionStore(r.db)
	key, err := devicekey.LoadOrCreateComputerKey(t.TempDir())
	require.NoError(t, err)
	logs := &bytes.Buffer{}
	cf := &failClear{SessionStore: ss}
	m := cloud.New(cloud.Options{HubURL: "https://app.coralhub.dev", Store: store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.dir)), MaxMode: func() tunnel.Mode { return tunnel.TierView },
		Devices: cf, ComputerKey: key, Logger: slog.New(slog.NewTextHandler(logs, nil))})
	r.srv.SetCloud(m)
	d := &dkRig{t: t, r: r, ss: ss, m: m, cf: cf, key: key, logs: logs}
	d.signer, d.kid = d.addDevice("launch", store.DeviceKindDevice)
	return d
}

func (d *dkRig) addDevice(mode, kind string) (*ecdsa.PrivateKey, string) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(d.t, err)
	e, _ := priv.ECDH()
	raw := e.PublicKey().Bytes()
	kid := rb64.EncodeToString(sha(raw))
	_, err = d.ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: kid, PK: raw, Label: "Phone", Mode: mode, Origin: store.DeviceOriginPairing, Kind: kind, Link: store.PairOwner, HubUser: store.PairOwner}, time.Now().Add(-time.Hour))
	require.NoError(d.t, err)
	return priv, kid
}

func sha(b []byte) []byte { h := sha256.Sum256(b); return h[:] }

// post sends a body to a device route the way the Hub forwards it: through the tunnel's via header, no user header.
func (d *dkRig) post(path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	h := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	for k, v := range hdr {
		h[k] = v
	}
	return call(d.r.srv.Router(), "POST", path, body, h)
}

func (d *dkRig) removal(targetKID string) (string, string) {
	d.nonce++
	n := make([]byte, 16)
	n[0], n[1] = byte(d.nonce), 7
	m := devicekey.Message{Action: devicekey.RemoveDevice, KID: d.kid, Computer: d.key.Computer(), Ts: time.Now().Unix(), Nonce: rb64.EncodeToString(n), TargetKID: targetKID}
	body, err := m.Canonical()
	require.NoError(d.t, err)
	return string(body), signP1363(d.t, d.signer, devicekey.SigningInput(m.Action, body))
}

func signP1363(t *testing.T, k *ecdsa.PrivateKey, msg []byte) string {
	t.Helper()
	h := sha256.Sum256(msg)
	r, s, err := ecdsa.Sign(rand.Reader, k, h[:])
	require.NoError(t, err)
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return rb64.EncodeToString(sig)
}

func msgJSON(action, body, sig string) string {
	b, _ := json.Marshal(map[string]string{"action": action, "body": body, "sig": sig})
	return string(b)
}

func errCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var v map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &v), rec.Body.String())
	return v["error"]
}

func TestASignedRemovalThroughTheRouteRemovesAndIsAudited(t *testing.T) {
	d := newDKRig(t)
	_, target := d.addDevice("view", store.DeviceKindDevice)
	body, sig := d.removal(target)
	rec := d.post("/api/device-keys/message", msgJSON("remove-device", body, sig), nil)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
	_, err := d.ss.ActiveDeviceKey(context.Background(), target, time.Now())
	assert.ErrorIs(t, err, store.ErrSignerRemoved)
	assert.Contains(t, d.logs.String(), "cloud: device key changed")
	assert.Contains(t, d.logs.String(), target)
	assert.NotContains(t, d.logs.String(), "Phone", "no label in the audit line")
}

// coral-hub Security (#249058): a pending clear refuses with list_unavailable, through the real route, before anything of the request is read.
func TestAPendingClearRefusesWithListUnavailableThroughBothRoutes(t *testing.T) {
	d := newDKRig(t)
	require.NoError(t, d.ss.SetDeviceClearPending(context.Background(), true)) // the mark a failed clear leaves
	_, target := d.addDevice("view", store.DeviceKindDevice)
	body, sig := d.removal(target)
	for _, c := range []struct{ path, b string }{
		{"/api/device-keys/message", msgJSON("remove-device", body, sig)},
		{"/api/device-keys/message", "not json at all"},
		{"/api/device-keys/certificate", "{}"},
	} {
		rec := d.post(c.path, c.b, nil)
		assert.Equal(t, "list_unavailable", errCode(t, rec), c.path)
		assert.Equal(t, 503, rec.Code)
	}
	_, err := d.ss.ActiveDeviceKey(context.Background(), target, time.Now())
	assert.NoError(t, err, "nothing was applied")
	require.NoError(t, d.ss.SetDeviceClearPending(context.Background(), false))
	assert.NotEqual(t, "list_unavailable", errCode(t, d.post("/api/device-keys/message", "x", nil)), "refusing ends when a clear works")
}

func TestEachRouteTakesOnlyItsOwnSignatureForm(t *testing.T) {
	d := newDKRig(t)
	_, target := d.addDevice("view", store.DeviceKindDevice)
	body, _ := d.removal(target)
	// a DER signature on the message route
	h := sha256.Sum256(devicekey.SigningInput(devicekey.RemoveDevice, []byte(body)))
	r, s, _ := ecdsa.Sign(rand.Reader, d.signer, h[:])
	der, _ := asn1.Marshal(struct{ R, S *big.Int }{r, s})
	rec := d.post("/api/device-keys/message", msgJSON("remove-device", body, rb64.EncodeToString(der)), nil)
	assert.Equal(t, "bad_signature", errCode(t, rec))
	// a P1363 signature on the certificate route
	c := map[string]any{"label": "New", "device_pk": rb64.EncodeToString(append([]byte{4}, make([]byte, 64)...)), "ts": time.Now().Unix(),
		"authenticator_data": rb64.EncodeToString(make([]byte, 37)), "client_data_json": rb64.EncodeToString([]byte(`{}`)), "signature": rb64.EncodeToString(make([]byte, 64))}
	cb, _ := json.Marshal(c)
	rec = d.post("/api/device-keys/certificate", string(cb), nil)
	assert.Equal(t, "bad_form", errCode(t, rec), "an off-curve key is a bad form before any signature")
	e, _ := ecdh.P256().GenerateKey(rand.Reader)
	c["device_pk"] = rb64.EncodeToString(e.PublicKey().Bytes())
	cb, _ = json.Marshal(c)
	rec = d.post("/api/device-keys/certificate", string(cb), nil)
	assert.Equal(t, "bad_signature", errCode(t, rec))
}

func TestAnOwnerClaimWithABadSignatureIsRefusedLikeNone(t *testing.T) {
	d := newDKRig(t)
	_, target := d.addDevice("view", store.DeviceKindDevice)
	body, sig := d.removal(target)
	bad := msgJSON("remove-device", body, sig[:80]+"AAAAAA")
	plain := d.post("/api/device-keys/message", bad, nil)
	claimed := d.post("/api/device-keys/message", bad, map[string]string{"X-Coral-Hub-User": "owner", tunnel.HubRoleHeader: "owner", "X-Coral-Hub-Account": "acct"})
	assert.Equal(t, plain.Code, claimed.Code)
	assert.Equal(t, plain.Body.String(), claimed.Body.String())
	_, err := d.ss.ActiveDeviceKey(context.Background(), target, time.Now())
	assert.NoError(t, err)
}

func TestEveryReplyIsOneOfTheClosedCodesAndUnder1KB(t *testing.T) {
	d := newDKRig(t)
	_, target := d.addDevice("view", store.DeviceKindDevice)
	body, sig := d.removal(target)
	for _, b := range []string{
		"", "{", `{"action":"x"}`, `{"action":"remove-device","body":"{}","sig":""}`, msgJSON("nope", body, sig), msgJSON("remove-device", "{}", sig),
		msgJSON("remove-device", body, "bad"), `{"action":"remove-device","body":"x","sig":"y","extra":1}`, strings.Repeat("a", 9000),
	} {
		rec := d.post("/api/device-keys/message", b, nil)
		require.NotEqual(t, 200, rec.Code, b)
		assert.LessOrEqual(t, rec.Body.Len(), 1024)
		assert.True(t, devicekey.InReplyCodes(errCode(t, rec)), "%s -> %s", b, rec.Body.String())
	}
}

// coral-hub rule (a): the largest message and the largest certificate the verifier would take fit under the Hub's 4096-byte cap, in the request this route reads.
func TestTheLargestMessageAndCertificateFitTheHubsCap(t *testing.T) {
	label := strings.Repeat("é", 32) // 64 bytes: the longest label
	require.True(t, devicekey.LabelOK(label))
	pk := rb64.EncodeToString(append([]byte{4}, make([]byte, 64)...))
	// worst-case JSON escaping: every label byte that JSON must escape is still within the label limit; the request wraps the canonical body as a string, escaping every quote.
	m := devicekey.Message{Action: devicekey.ApproveDevice, KID: strings.Repeat("A", 43), Computer: strings.Repeat("A", 43), Ts: 9_999_999_999_999_999, Nonce: strings.Repeat("A", 22), TargetKID: strings.Repeat("A", 43), TargetPK: pk, Label: label, Mode: "interact"}
	body, err := m.Canonical()
	if err == nil {
		assert.LessOrEqual(t, len(msgJSON("approve-device", string(body), strings.Repeat("A", 86))), 4096)
		assert.LessOrEqual(t, len(body), 2048, "the message itself is at most 2048")
	}
	rp, _ := ecdh.P256().GenerateKey(rand.Reader)
	cert := map[string]any{"label": label, "device_pk": rb64.EncodeToString(rp.PublicKey().Bytes()), "ts": int64(9_999_999_999_999_999), "authenticator_data": rb64.EncodeToString(make([]byte, 37)),
		"client_data_json": rb64.EncodeToString(bytes.Repeat([]byte("x"), 1024)), "signature": rb64.EncodeToString(make([]byte, 72))}
	cb, _ := json.Marshal(cert)
	assert.LessOrEqual(t, len(cb), 4096, "a maximum certificate: 1 KB clientDataJSON, 37-byte authenticatorData, 72-byte signature, 64-byte label")
	d := newDKRig(t)
	cert["ts"] = time.Now().Unix()
	cb, _ = json.Marshal(cert)
	rec := d.post("/api/device-keys/certificate", string(cb), nil)
	assert.NotEqual(t, "bad_form", errCode(t, rec), "the route reads the maximum certificate whole")
}

func TestARequestOverTheCapIsBadForm(t *testing.T) {
	d := newDKRig(t)
	_, target := d.addDevice("view", store.DeviceKindDevice)
	body, sig := d.removal(target)
	padded := msgJSON("remove-device", body, sig) + strings.Repeat(" ", 4096)
	rec := d.post("/api/device-keys/message", padded, nil)
	assert.Equal(t, "bad_form", errCode(t, rec), "a valid signed message over 4096 bytes is not read")
	_, err := d.ss.ActiveDeviceKey(context.Background(), target, time.Now())
	assert.NoError(t, err)
}

// A sender who has not proved a key is not told whether a kid is listed, was removed, or which computer this is: all three are bad_signature.
func TestAnUnlistedRemovedOrWrongComputerSenderGetsBadSignature(t *testing.T) {
	d := newDKRig(t)
	_, target := d.addDevice("view", store.DeviceKindDevice)
	// an unlisted signer
	stranger, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	e, _ := stranger.ECDH()
	m := devicekey.Message{Action: devicekey.RemoveDevice, KID: rb64.EncodeToString(sha(e.PublicKey().Bytes())), Computer: d.key.Computer(), Ts: time.Now().Unix(), Nonce: rb64.EncodeToString(make([]byte, 16)), TargetKID: target}
	b, _ := m.Canonical()
	assert.Equal(t, "bad_signature", errCode(t, d.post("/api/device-keys/message", msgJSON("remove-device", string(b), signP1363(t, stranger, devicekey.SigningInput(m.Action, b))), nil)))
	// a removed signer
	priv, kid := d.addDevice("view", store.DeviceKindDevice)
	require.NoError(t, d.ss.RemoveDeviceKey(context.Background(), kid, store.DeviceRemoved, time.Now()))
	m.KID = kid
	b, _ = m.Canonical()
	assert.Equal(t, "bad_signature", errCode(t, d.post("/api/device-keys/message", msgJSON("remove-device", string(b), signP1363(t, priv, devicekey.SigningInput(m.Action, b))), nil)))
	// another computer
	m.KID, m.Computer = d.kid, rb64.EncodeToString(make([]byte, 32))
	b, _ = m.Canonical()
	assert.Equal(t, "bad_signature", errCode(t, d.post("/api/device-keys/message", msgJSON("remove-device", string(b), signP1363(t, d.signer, devicekey.SigningInput(m.Action, b))), nil)))
}

// Review #19738 SHOULD 1: only FAILED checks use the budget, per claimed signer, so a flood of bad messages cannot delay a signed removal from another signer, and good ones never use it.
func TestAFloodOfBadMessagesDoesNotDelayAnotherSignersRemoval(t *testing.T) {
	d := newDKRig(t)
	_, target := d.addDevice("view", store.DeviceKindDevice)
	body, sig := d.removal(target)
	// The flood claims a kid nobody listed: more failed checks than the budget.
	flood := msgJSON("remove-device", strings.Replace(body, d.kid, "A"+d.kid[1:], 1), sig)
	for i := 0; i < 80; i++ {
		d.post("/api/device-keys/message", flood, nil)
	}
	rec := d.post("/api/device-keys/message", flood, nil)
	assert.Equal(t, "internal", errCode(t, rec), "the flooded signer's own budget is spent")
	rec = d.post("/api/device-keys/message", msgJSON("remove-device", body, sig), nil)
	require.Equal(t, 200, rec.Code, "another signer's signed removal still goes through: %s", rec.Body.String())
}

func TestGoodMessagesNeverUseTheBudget(t *testing.T) {
	d := newDKRig(t)
	for i := 0; i < 40; i++ {
		_, target := d.addDevice("view", store.DeviceKindDevice)
		body, sig := d.removal(target)
		rec := d.post("/api/device-keys/message", msgJSON("remove-device", body, sig), nil)
		require.Equal(t, 200, rec.Code, "removal %d: %s", i, rec.Body.String())
	}
}

// Review #19745 SHOULD 1: invented kids cannot push a listed signer out (any number of them share one bucket), and a signer's budget is its own.
func TestInventedKidsShareOneBucketAndNeverTouchAListedSigner(t *testing.T) {
	d := newDKRig(t)
	_, target := d.addDevice("view", store.DeviceKindDevice)
	body, sig := d.removal(target)
	for i := 0; i < 400; i++ {
		fake := fmt.Sprintf("%043d", i)
		d.post("/api/device-keys/message", msgJSON("remove-device", strings.Replace(body, d.kid, fake, 1), sig), nil)
	}
	rec := d.post("/api/device-keys/message", msgJSON("remove-device", strings.Replace(body, d.kid, fmt.Sprintf("%043d", 999), 1), sig), nil)
	assert.Equal(t, "internal", errCode(t, rec), "all invented kids share one spent bucket")
	rec = d.post("/api/device-keys/message", msgJSON("remove-device", body, sig), nil)
	require.Equal(t, 200, rec.Code, "the listed signer still has its own budget: %s", rec.Body.String())
}
