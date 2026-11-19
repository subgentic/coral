package cloud

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
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

// The verifier in production (#19669 slice 7): built in one place, with Refuse on the manager's pending-clear mark, HubOrigin from the configured HubURL and the audit line.

func TestTheBuiltVerifierHasRefuseHubOriginAndAudit(t *testing.T) {
	r := pairingSetup(t, true)
	v := r.m.NewDeviceVerifier(r.ss)
	require.NotNil(t, v)
	assert.NotNil(t, v.Refuse, "a verifier without Refuse would act while a clear is pending")
	assert.NotNil(t, v.Audit)
	assert.Equal(t, r.m.o.HubURL, v.HubOrigin, "the configured HubURL, never an address from a message")
	assert.Equal(t, r.key.Computer(), v.Computer)
}

func TestTheBuiltVerifierRefusesWhileAClearIsPending(t *testing.T) {
	r := pairingSetup(t, true)
	cf := &clearFails{SessionStore: r.ss, fail: true}
	r.m.o.Devices = cf
	require.False(t, r.m.clearDeviceKeys(context.Background()))
	v := r.m.NewDeviceVerifier(r.ss)
	assert.True(t, v.Refuse(), "tied to the manager's own mark")
	_, err := v.Handle(context.Background(), devicekey.RemoveDevice, []byte("{}"), "", time.Now())
	assert.ErrorIs(t, err, devicekey.ErrListUnavailable)
	cf.fail = false
	require.True(t, r.m.clearDeviceKeys(context.Background()))
	assert.False(t, v.Refuse())
}

// A nonce store that cannot be read when the verifier is built refuses what is dated before now (before_start); a readable one sets nothing.
type nonceUnreadable struct{ *store.SessionStore }

func (nonceUnreadable) NonceSeen(context.Context, string, time.Time) error {
	return errors.New("disk error")
}

func TestAnUnreadableNonceStoreSetsRefuseBeforeAndAReadableOneDoesNot(t *testing.T) {
	r := pairingSetup(t, true)
	v := r.m.NewDeviceVerifier(r.ss)
	assert.True(t, v.RefuseBefore.IsZero(), "a readable nonce store sets no refusal")
	r2 := pairingSetup(t, true)
	v2 := r2.m.NewDeviceVerifier(nonceUnreadable{r2.ss})
	require.NotNil(t, v2)
	assert.True(t, v2.RefuseBefore.After(time.Now().Add(23*time.Hour)), "an unreadable one refuses what is dated before now plus the window")
}

func TestTheBuiltVerifierWithNoComputerKeyOrHubIsNil(t *testing.T) {
	r := pairingSetup(t, false)
	assert.Nil(t, r.m.NewDeviceVerifier(r.ss), "no computer key: no verifier, so no message is ever checked against nothing")
}

func TestTheAuditLineOfARemovalHasTheKidsAndModeAndNoLabel(t *testing.T) {
	var buf bytes.Buffer
	r := pairingSetup(t, true)
	r.m.o.Logger = slog.New(slog.NewTextHandler(&buf, nil))
	v := r.m.NewDeviceVerifier(r.ss)
	v.Audit(devicekey.RemoveDevice, "signer-kid", "target-kid", "interact")
	out := buf.String()
	assert.Contains(t, out, "signer-kid")
	assert.Contains(t, out, "target-kid")
	assert.Contains(t, out, "interact")
}

func TestTheAuditLineOfACertificateNamesBothKidsAndNoLabel(t *testing.T) {
	var buf bytes.Buffer
	r := pairingSetup(t, true)
	r.m.o.Logger = slog.New(slog.NewTextHandler(&buf, nil))
	v := r.m.NewDeviceVerifier(r.ss)
	require.NotNil(t, v.AuditCert)
	v.AuditCert("passkey-kid", "device-kid", "view")
	out := buf.String()
	assert.Contains(t, out, "passkey-kid")
	assert.Contains(t, out, "device-kid")
	assert.Contains(t, out, "view")
}

// A pin: a Verifier is built in one place only, so no second construction can leave Refuse or HubOrigin out.
func TestNoVerifierIsBuiltOutsideTheManagersBuilder(t *testing.T) {
	var offenders []string
	require.NoError(t, filepath.Walk("..", func(p string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		b, _ := os.ReadFile(p)
		if bytes.Contains(b, []byte("devicekey.Verifier{")) && filepath.Base(p) != "device_verifier.go" {
			offenders = append(offenders, p)
		}
		return nil
	}))
	assert.Empty(t, offenders, "build the verifier with Manager.NewDeviceVerifier")
}

func TestTheManagerBuildsOneVerifier(t *testing.T) {
	r := pairingSetup(t, true)
	assert.Same(t, r.m.NewDeviceVerifier(r.ss), r.m.NewDeviceVerifier(r.ss), "one mutex serializes every message")
}
