package cloud

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// a connected computer with a device key; no secret is held at its enrollment, so nothing is listed.
func connectedRig(t *testing.T) *pairingRig {
	t.Helper()
	r := pairingSetup(t, true)
	require.NoError(t, r.m.Connect(context.Background()))
	waitState(t, r.m, StateConnected)
	require.Empty(t, r.listed(t))
	return r
}

type browserAnswer struct {
	code, label string
	a           devicekey.PairingAnswer
	pk          []byte
	secret      []byte
}

// answerFor is what a browser makes from the started pairing's link: the secret from its fragment, a fresh key (or pk when given).
func answerFor(t *testing.T, v PairBrowserView, label string, pk []byte) browserAnswer {
	t.Helper()
	u, err := url.Parse(v.Link)
	require.NoError(t, err)
	frag, err := url.ParseQuery(u.Fragment)
	require.NoError(t, err)
	secret, ok := devicekey.ParsePairingSecret(frag.Get("p"))
	require.True(t, ok)
	if pk == nil {
		pk, _ = b64u.DecodeString(newDevicePK(t))
	}
	code := u.Query().Get("c")
	mac := devicekey.PairMAC(secret, code, label, pk)
	return browserAnswer{code: code, label: label, pk: pk, secret: secret, a: devicekey.PairingAnswer{V: 1, KID: devicekey.KIDOf(pk), MAC: b64u.EncodeToString(mac), PK: b64u.EncodeToString(pk)}}
}

func (b browserAnswer) ask(m *Manager, link string) (PairAnswerResult, error) {
	return m.AnswerPairBrowser(link, b.code, b.label, b.a)
}

func startPair(t *testing.T, r *pairingRig) (PairBrowserView, string) {
	t.Helper()
	v, err := r.m.StartPairBrowser(context.Background())
	require.NoError(t, err)
	link, err := r.m.linkForTunnel(context.Background())
	require.NoError(t, err)
	return v, link.LinkID
}

func TestAPairedBrowserIsListedOnlyAfterTheLocalAllowAndGetsOneReply(t *testing.T) {
	r := connectedRig(t)
	v, link := startPair(t, r)
	require.True(t, v.Active)
	b := answerFor(t, v, "My Phone", nil)
	res, err := b.ask(r.m, link)
	require.NoError(t, err)
	assert.Equal(t, "pending", res.State)
	assert.Empty(t, r.listed(t), "nothing is listed before the person here allows it")
	st := r.m.PairBrowserState()
	require.NotNil(t, st.Pending)
	assert.Equal(t, "My Phone", st.Pending.Label)
	assert.Equal(t, devicekey.DisplayFingerprint(b.pk), st.Pending.Fingerprint)
	res, err = b.ask(r.m, link) // asking again is the same wait, not a second pending
	require.NoError(t, err)
	assert.Equal(t, "pending", res.State)

	require.NoError(t, r.m.AllowPairBrowser(context.Background(), ""))
	l := r.listed(t)
	require.Len(t, l, 1)
	assert.Equal(t, devicekey.KIDOf(b.pk), l[0].KID)
	assert.Equal(t, store.DeviceOriginPairing, l[0].Origin)
	assert.Equal(t, "view", l[0].Mode, "view unless the person chose a higher one")
	assert.Equal(t, store.PairOwner, l[0].Link)

	res, err = b.ask(r.m, link)
	require.NoError(t, err)
	assert.Equal(t, "ok", res.State)
	assert.Equal(t, devicekey.ReplyMAC(b.secret, b.code, b.pk, r.key.Pub()), res.Reply)
	assert.Equal(t, r.m.ComputerID(), res.Computer)
	_, err = b.ask(r.m, link)
	assert.Error(t, err, "the reply is read once; the pairing is over")
	assert.False(t, r.m.PairBrowserState().Active)
}

func TestTheModeIsThePersonsChoiceAndNeverAboveTheCap(t *testing.T) {
	r := connectedRig(t)
	r.m.o.MaxMode = func() tunnel.Mode { return tunnel.TierInteract }
	v, link := startPair(t, r)
	b := answerFor(t, v, "Tablet", nil)
	_, err := b.ask(r.m, link)
	require.NoError(t, err)
	assert.ErrorIs(t, r.m.AllowPairBrowser(context.Background(), "launch"), ErrPairBrowserModeAbove)
	assert.ErrorIs(t, r.m.AllowPairBrowser(context.Background(), "root"), ErrPairBrowserBadMode)
	assert.Empty(t, r.listed(t))
	require.NoError(t, r.m.AllowPairBrowser(context.Background(), "interact"))
	assert.Equal(t, "interact", r.listed(t)[0].Mode)
}

func TestEveryRefusedAnswerIsTheSameError(t *testing.T) {
	r := connectedRig(t)
	good := func() (PairBrowserView, string) { return startPair(t, r) }

	_, err0 := (browserAnswer{}).ask(r.m, "lnk-00000000") // no pairing started
	v, link := good()
	other := answerFor(t, v, "X", nil)
	_, err1 := other.ask(r.m, "lnk-other") // another Hub link
	badMAC := answerFor(t, v, "X", nil)
	badMAC.a.MAC = b64u.EncodeToString(make([]byte, 32))
	_, err2 := badMAC.ask(r.m, link)
	badKID := answerFor(t, v, "X", nil)
	badKID.a.KID = strings.Repeat("A", 43)
	_, err3 := badKID.ask(r.m, link)
	badKey := answerFor(t, v, "X", nil)
	badKey.a.PK = "AAAA"
	_, err4 := badKey.ask(r.m, link)
	for i, err := range []error{err0, err1, err2, err3, err4} {
		assert.ErrorIs(t, err, devicekey.ErrPairingMAC, "case %d", i)
	}
	assert.Empty(t, r.listed(t))
}

func TestThreeWrongAnswersEndThePairing(t *testing.T) {
	r := connectedRig(t)
	v, link := startPair(t, r)
	bad := answerFor(t, v, "X", nil)
	bad.a.MAC = b64u.EncodeToString(make([]byte, 32))
	for i := 0; i < 3; i++ {
		_, err := bad.ask(r.m, link)
		require.Error(t, err)
	}
	good := answerFor(t, v, "Y", nil)
	_, err := good.ask(r.m, link)
	assert.Error(t, err, "the hold is dead: even the right answer is refused")
	assert.False(t, r.m.PairBrowserState().Active)
}

func TestDenyRefusesOnceAndListsNothing(t *testing.T) {
	r := connectedRig(t)
	v, link := startPair(t, r)
	b := answerFor(t, v, "Phone", nil)
	_, err := b.ask(r.m, link)
	require.NoError(t, err)
	require.NoError(t, r.m.DenyPairBrowser())
	res, err := b.ask(r.m, link)
	require.NoError(t, err)
	assert.Equal(t, "refused", res.State)
	assert.Empty(t, r.listed(t))
}

func TestAnAnswerNobodyAllowsExpiresAfterTwoMinutes(t *testing.T) {
	r := connectedRig(t)
	now := time.Now()
	r.m.o.Now = func() time.Time { return now }
	v, link := startPair(t, r)
	b := answerFor(t, v, "Phone", nil)
	_, err := b.ask(r.m, link)
	require.NoError(t, err)
	now = now.Add(pairBrowserPending + time.Second)
	assert.ErrorIs(t, r.m.AllowPairBrowser(context.Background(), ""), ErrPairBrowserNothing)
	assert.Empty(t, r.listed(t))
	now = now.Add(pairBrowserLife)
	assert.False(t, r.m.PairBrowserState().Active, "the secret itself is gone after ten minutes")
}

func TestTheLinkCarriesTheSecretOnlyInItsFragmentAndOnlyWhileHeld(t *testing.T) {
	r := connectedRig(t)
	v, _ := startPair(t, r)
	u, err := url.Parse(v.Link)
	require.NoError(t, err)
	frag, _ := url.ParseQuery(u.Fragment)
	secret := frag.Get("p")
	require.Len(t, secret, 22)
	assert.NotContains(t, u.RequestURI(), secret, "what a request would carry has no secret")
	assert.NotContains(t, u.Path+"?"+u.RawQuery, secret)
	r.m.CancelPairBrowser()
	st := r.m.PairBrowserState()
	assert.False(t, st.Active)
	assert.Empty(t, st.Link)
	assert.NotContains(t, mustJSON(st), secret)
}

func TestAKeyAlreadyListedAsBootstrapIsPromotedWithoutChangingItsMode(t *testing.T) {
	r := connectedRig(t)
	pk, _ := b64u.DecodeString(newDevicePK(t))
	_, err := r.ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: devicekey.KIDOf(pk), PK: pk, Label: "Bootstrap device", Mode: "view", Origin: store.DeviceOriginBootstrap, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner}, time.Now())
	require.NoError(t, err)
	r.m.o.MaxMode = func() tunnel.Mode { return tunnel.TierLaunch }
	v, link := startPair(t, r)
	b := answerFor(t, v, "Phone", pk)
	_, err = b.ask(r.m, link)
	require.NoError(t, err)
	require.NoError(t, r.m.AllowPairBrowser(context.Background(), "launch"))
	l := r.listed(t)
	require.Len(t, l, 1)
	assert.Equal(t, store.DeviceOriginPairing, l[0].Origin)
	assert.Equal(t, "view", l[0].Mode, "the one upward step is the origin, not the mode")
}

func TestNoPairingStartsWithoutAConnectionOrAComputerKey(t *testing.T) {
	r := pairingSetup(t, true) // not connected
	_, err := r.m.StartPairBrowser(context.Background())
	assert.ErrorIs(t, err, ErrPairBrowserNotLinked)
	r2 := pairingSetup(t, false)
	_, err = r2.m.StartPairBrowser(context.Background())
	assert.ErrorIs(t, err, ErrPairBrowserNoKey)
}
