package cloud

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

type pairingRig struct {
	e      *env
	ss     *store.SessionStore
	m      *Manager
	key    *devicekey.ComputerKey
	secret string
	pk     []byte
	kid    string
}

// pairingSetup makes a manager with the device options and a hub that answers the poll with a pairing made from secret (user_code and label as the fake hub gives them).
func pairingSetup(t *testing.T, withKey bool) *pairingRig {
	t.Helper()
	e := newEnv(t)
	r := &pairingRig{e: e, ss: store.NewSessionStore(e.db), secret: devicekey.NewPairingSecret()}
	if withKey {
		k, err := devicekey.LoadOrCreateComputerKey(t.TempDir())
		require.NoError(t, err)
		r.key = k
	}
	b := newDevicePK(t)
	r.pk, _ = b64u.DecodeString(b)
	r.kid = devicekey.KIDOf(r.pk)
	e.hub.verifyEnd.Store("")
	secret, _ := devicekey.ParsePairingSecret(r.secret)
	mac := b64u.EncodeToString(devicekey.PairMAC(secret, "ABCD-EFGH", "My Laptop", r.pk))
	e.hub.pairing.Store(map[string]any{"v": 1, "kid": r.kid, "mac": mac, "user_code": "ABCD-EFGH", "pk": b})
	m := e.manager(e.hub.srv.URL)
	m.o.Devices = r.ss
	m.o.ComputerKey = r.key
	m.o.PairedDeviceMode = func() string { return "launch" }
	r.m = m
	start(t, m)
	return r
}

func (r *pairingRig) connect(t *testing.T) {
	t.Helper()
	r.m.SetPairingSecret(r.secret)
	require.NoError(t, r.m.Connect(context.Background()))
	waitState(t, r.m, StateConnected)
}

// listed is the active keys: a removed row stays in the list for 90 days and is not a key.
func (r *pairingRig) listed(t *testing.T) []store.DeviceKey {
	t.Helper()
	l, err := r.ss.ListDeviceKeys(context.Background())
	require.NoError(t, err)
	var active []store.DeviceKey
	for _, k := range l {
		if k.RemovedAt == 0 {
			active = append(active, k)
		}
	}
	return active
}

func TestAGoodPairingAddsTheDeviceAndSendsOneReply(t *testing.T) {
	r := pairingSetup(t, true)
	r.connect(t)
	l := r.listed(t)
	require.Len(t, l, 1)
	assert.Equal(t, r.kid, l[0].KID)
	assert.Equal(t, store.DeviceOriginPairing, l[0].Origin)
	assert.Equal(t, "launch", l[0].Mode)
	assert.Equal(t, "My Laptop", l[0].Label)
	require.Eventually(t, func() bool { return len(r.e.hub.replyBodies()) == 1 }, 5*time.Second, 10*time.Millisecond)
	body := r.e.hub.replyBodies()[0]
	assert.Len(t, body, 3)
	assert.Equal(t, b64u.EncodeToString(r.key.Pub()), body["computer_pub"])
	secret, _ := devicekey.ParsePairingSecret(r.secret)
	want := devicekey.ReplyMAC(secret, "ABCD-EFGH", r.pk, r.key.Pub())
	assert.Equal(t, b64u.EncodeToString(want), body["reply_mac"])
	assert.Equal(t, strings.Repeat("d", 43), body["device_code"])
	assert.Equal(t, "added", r.m.Status().DevicePairing)
	time.Sleep(100 * time.Millisecond)
	assert.Len(t, r.e.hub.replyBodies(), 1, "once")
}

func TestABadMACAddsNothingAndSendsNoReply(t *testing.T) {
	r := pairingSetup(t, true)
	r.m.SetPairingSecret(devicekey.NewPairingSecret()) // not the browser's secret
	require.NoError(t, r.m.Connect(context.Background()))
	waitState(t, r.m, StateConnected)
	assert.Empty(t, r.listed(t))
	assert.Empty(t, r.e.hub.replyBodies())
	assert.Contains(t, r.m.Status().DevicePairing, "not added")
	assert.NotContains(t, mustJSON(r.m.Status()), r.secret)
}

func TestNoSecretHeldRefusesThePairingWithAMessage(t *testing.T) {
	r := pairingSetup(t, true) // the link had no #p= (a restart, or another way of starting): no SetPairingSecret
	require.NoError(t, r.m.Connect(context.Background()))
	waitState(t, r.m, StateConnected)
	assert.Empty(t, r.listed(t))
	assert.Empty(t, r.e.hub.replyBodies())
	assert.Contains(t, r.m.Status().DevicePairing, "not added")
}

func TestAnAnswerWithoutPkIsStepOneWhenTheComputerHasItsKeyAndRefusedWhenItDoesNot(t *testing.T) {
	for _, withKey := range []bool{true, false} {
		r := pairingSetup(t, withKey)
		pr := r.e.hub.pairing.Load().(map[string]any)
		delete(pr, "pk")
		r.e.hub.pairing.Store(pr)
		r.connect(t)
		assert.Empty(t, r.listed(t), "withKey=%v", withKey)
		assert.Empty(t, r.e.hub.replyBodies())
		if withKey {
			assert.Empty(t, r.m.Status().DevicePairing, "step 1: nothing said, nothing kept")
		} else {
			assert.Contains(t, r.m.Status().DevicePairing, "not added")
		}
	}
}

// Lead Q1: a new enrollment clears every earlier key; so does losing the link.
func TestAnEnrollmentClearsEarlierKeysAndSoDoesDisconnect(t *testing.T) {
	r := pairingSetup(t, true)
	old := newDevicePK(t)
	raw, _ := b64u.DecodeString(old)
	_, err := r.ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: devicekey.KIDOf(raw), PK: raw, Label: "old", Mode: "view", Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice}, time.Now())
	require.NoError(t, err)
	r.connect(t)
	for _, k := range r.listed(t) {
		assert.NotEqual(t, devicekey.KIDOf(raw), k.KID, "the earlier key is gone")
	}
	require.NoError(t, r.m.Disconnect(context.Background()))
	assert.Empty(t, r.listed(t), "no active key survives a disconnect")
}

func TestTheSecretIsNowhereButTheLinkAndMemory(t *testing.T) {
	r := pairingSetup(t, true)
	r.connect(t)
	conn, err := r.e.cs.Get(context.Background())
	require.NoError(t, err)
	for name, text := range map[string]string{"status": mustJSON(r.m.Status()), "stored": fmt.Sprintf("%+v", conn), "log": r.e.logs.String()} {
		assert.NotContains(t, text, r.secret, name)
	}
	l, _ := r.ss.ListDeviceKeys(context.Background())
	assert.NotContains(t, fmt.Sprintf("%+v", l), r.secret, "the device rows")
	_ = filepath.Join
}

// The bootstrap device key the credential handed over is a `bootstrap` row.
func TestTheRedeemedDevicePKIsWrittenAsABootstrapRow(t *testing.T) {
	r := pairingSetup(t, true)
	pk := newDevicePK(t)
	r.m.recordBootstrapDevice(context.Background(), pk)
	l := r.listed(t)
	require.Len(t, l, 1)
	assert.Equal(t, store.DeviceOriginBootstrap, l[0].Origin)
	assert.Equal(t, "view", l[0].Mode)
	assert.Equal(t, store.DeviceKindDevice, l[0].Kind)
}
