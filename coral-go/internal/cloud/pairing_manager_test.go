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

// Security's SHOULD 3 on #19689: a bootstrap enrollment clears the old keys whether or not a device key came with it; a refused one clears nothing.
func TestABootstrapEnrollmentClearsTheKeysEvenWithoutADevicePK(t *testing.T) {
	r := pairingSetup(t, true)
	ctx := context.Background()
	r.m.recordBootstrapDevice(ctx, newDevicePK(t))
	require.Len(t, r.listed(t), 1)

	r.m.afterBootstrap(ctx, BootstrapResult{Status: BootstrapRefused}, CredentialSource{})
	require.Len(t, r.listed(t), 1, "a refused enrollment changes nothing")

	r.m.afterBootstrap(ctx, BootstrapResult{Status: BootstrapEnrolled}, CredentialSource{})
	assert.Empty(t, r.listed(t), "enrolled with no device key: the old list is cleared")

	r.m.afterBootstrap(ctx, BootstrapResult{Status: BootstrapEnrolled}, CredentialSource{DevicePK: newDevicePK(t)})
	assert.Len(t, r.listed(t), 1, "with a key: cleared, then the new bootstrap row")
}

// A list that will not clear (the store errors on RemoveAllDeviceKeys) fails closed. Embedded: every other call is the real store.
type clearFails struct {
	*store.SessionStore
	fail bool
	n    int
}

func (c *clearFails) RemoveAllDeviceKeys(ctx context.Context, now time.Time) (int, error) {
	c.n++
	if c.fail {
		return 0, fmt.Errorf("disk is full")
	}
	return c.SessionStore.RemoveAllDeviceKeys(ctx, now)
}

// coral-hub Security on #19689 (1): a failed clear adds no new pairing and says so, the old list is not extended, and the next call retries the clear.
func TestAFailedClearAddsNoPairingAndIsRetriedNextTime(t *testing.T) {
	r := pairingSetup(t, true)
	cf := &clearFails{SessionStore: r.ss, fail: true}
	r.m.o.Devices = cf
	oldPK := newDevicePK(t)
	r.m.recordBootstrapDevice(context.Background(), oldPK) // the earlier account's key
	require.Len(t, r.listed(t), 1)

	r.connect(t)
	assert.Len(t, r.listed(t), 1, "only the earlier key: the new pairing was not added to a list that would not clear")
	assert.Contains(t, r.m.Status().DevicePairing, "not added")
	assert.Contains(t, r.m.Status().DevicePairing, "old device list")
	assert.Empty(t, r.e.hub.replyBodies(), "no reply is sent for a pairing that was not added")

	// The next enrollment retries the clear, and with it working the pairing goes through.
	cf.fail = false
	require.NoError(t, r.m.Disconnect(context.Background()))
	r.connect(t)
	assert.GreaterOrEqual(t, cf.n, 2, "retried")
	l := r.listed(t)
	require.Len(t, l, 1)
	assert.Equal(t, r.kid, l[0].KID)
}

// The same for a bootstrap enrollment: a clear that fails records no bootstrap row beside the old keys.
func TestABootstrapWhoseClearFailsRecordsNoRow(t *testing.T) {
	r := pairingSetup(t, true)
	cf := &clearFails{SessionStore: r.ss, fail: true}
	r.m.o.Devices = cf
	r.m.afterBootstrap(context.Background(), BootstrapResult{Status: BootstrapEnrolled}, CredentialSource{DevicePK: newDevicePK(t)})
	assert.Empty(t, r.listed(t))
	cf.fail = false
	r.m.afterBootstrap(context.Background(), BootstrapResult{Status: BootstrapEnrolled}, CredentialSource{DevicePK: newDevicePK(t)})
	assert.Len(t, r.listed(t), 1, "retried and recorded")
}

// (2) No PairedDeviceMode function: the lowest mode, never launch.
func TestNoPairedDeviceModeFunctionGivesView(t *testing.T) {
	r := pairingSetup(t, true)
	r.m.o.PairedDeviceMode = nil
	r.connect(t)
	l := r.listed(t)
	require.Len(t, l, 1)
	assert.Equal(t, "view", l[0].Mode)
}

// A link lost whose clear fails still ends what it must end (the wipe and the callback), and the next pairing then refuses until a clear works.
func TestALinkLostWhoseClearFailsStillWipesTheSecretAndFailsClosedAfter(t *testing.T) {
	r := pairingSetup(t, true)
	cf := &clearFails{SessionStore: r.ss, fail: true}
	r.m.o.Devices = cf
	r.m.SetPairingSecret(r.secret)
	r.m.recordBootstrapDevice(context.Background(), newDevicePK(t))
	called := false
	r.m.o.OnLinkLost = func(context.Context) { called = true }
	r.m.linkLost(context.Background())
	assert.True(t, called)
	assert.False(t, r.m.PairingSecretHeld(), "the secret is wiped whatever the store did")
	assert.Len(t, r.listed(t), 1, "the stale key could not be removed")
	assert.True(t, r.m.deviceClearPending(), "and the manager knows: a pairing refuses until a clear works")
}

// coral-hub condition (c): the mode comes from the computer's own setting at the moment of pairing, read each time: changing the setting before the next pairing changes what it grants, and nothing in the request or the Hub's answer does.
func TestThePairedModeIsReadFromTheComputersSettingAtPairingTime(t *testing.T) {
	r := pairingSetup(t, true)
	r.m.o.PairedDeviceMode = func() string { return r.ss.DeviceWebMode(context.Background()) }
	require.NoError(t, r.ss.SetDeviceWebMode(context.Background(), "view"))
	r.connect(t)
	l := r.listed(t)
	require.Len(t, l, 1)
	assert.Equal(t, "view", l[0].Mode, "the setting at pairing time")
}

// coral-hub condition (d): each pairing is audited with the kid and the mode it was given; nothing else of the key (no secret, no MAC) is in the line.
func TestAPairingIsAuditedWithTheKidAndTheMode(t *testing.T) {
	r := pairingSetup(t, true)
	r.connect(t)
	logs := r.e.logs.String()
	line := ""
	for _, l := range strings.Split(logs, "\n") {
		if strings.Contains(l, "device paired") {
			line = l
		}
	}
	require.NotEmpty(t, line, logs)
	assert.Contains(t, line, "kid="+r.kid)
	assert.Contains(t, line, "mode=launch")
	assert.NotContains(t, logs, r.secret)
}

// coral-hub condition (a), at the manager: a secret older than ten minutes adds nothing, and a secret already used once cannot pair a second browser.
func TestAnOldOrUsedSecretPairsNothing(t *testing.T) {
	r := pairingSetup(t, true)
	base := time.Now()
	r.m.o.Now = func() time.Time { return base }
	r.m.SetPairingSecret(r.secret)
	r.m.o.Now = func() time.Time { return base.Add(10*time.Minute + time.Second) }
	require.NoError(t, r.m.Connect(context.Background()))
	waitState(t, r.m, StateConnected)
	assert.Empty(t, r.listed(t), "ten minutes passed")
	assert.Contains(t, r.m.Status().DevicePairing, "not added")

	r2 := pairingSetup(t, true)
	r2.connect(t)
	require.Len(t, r2.listed(t), 1)
	require.NoError(t, r2.m.Disconnect(context.Background()))
	require.NoError(t, r2.m.Connect(context.Background())) // no new secret: the first was used up
	waitState(t, r2.m, StateConnected)
	assert.Empty(t, r2.listed(t), "an enrollment clears the list, and the used secret pairs nothing again")
	assert.Contains(t, r2.m.Status().DevicePairing, "not added")
}

// DeviceClearPending is the verifier's switch: true after a failed clear, false after one works.
func TestDeviceClearPendingFollowsTheClear(t *testing.T) {
	r := pairingSetup(t, true)
	cf := &clearFails{SessionStore: r.ss, fail: true}
	r.m.o.Devices = cf
	assert.False(t, r.m.DeviceClearPending())
	r.m.afterBootstrap(context.Background(), BootstrapResult{Status: BootstrapEnrolled}, CredentialSource{})
	assert.True(t, r.m.DeviceClearPending(), "a failed clear: refuse every signed message")
	cf.fail = false
	r.m.afterBootstrap(context.Background(), BootstrapResult{Status: BootstrapEnrolled}, CredentialSource{})
	assert.False(t, r.m.DeviceClearPending())
}
