package cloud

import (
	"bytes"
	"image/png"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/devicekey"
)

func TestEnrollmentQRFollowsCurrentLiveHoldAndEnrollment(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	m := New(Options{HubURL: "https://hub.example", Now: func() time.Time { return now }})
	m.SetPairingSecret("AAAAAAAAAAAAAAAAAAAAAA")
	m.st = Status{State: StateEnrolling, UserCode: "ABCD-EFGH", VerificationURL: "https://hub.example/enroll?code=ABCD-EFGH", ExpiresAt: now.Add(15 * time.Minute)}
	require.Equal(t, now.Add(10*time.Minute), m.Status().EnrollmentQRExpiresAt)
	b := m.EnrollmentQRPNG()
	require.NotEmpty(t, b)
	image, err := png.Decode(bytes.NewReader(b))
	require.NoError(t, err)
	require.Equal(t, 256, image.Bounds().Dx())
	m.SetPairingSecret(devicekey.NewPairingSecret())
	require.NotEmpty(t, m.EnrollmentQRPNG(), "a pending enrollment can be reused with a replacement secret")
	require.NotEqual(t, b, m.EnrollmentQRPNG(), "the QR carries the new capability, never the wiped one")
	now = now.Add(10 * time.Minute)
	require.Empty(t, m.EnrollmentQRPNG(), "expiry is a hard boundary")
	require.True(t, m.Status().EnrollmentQRExpiresAt.IsZero())
	now = now.Add(-time.Minute)
	for _, s := range []string{StateConnected, StateConnecting, StateIdle, StateRevoked} {
		m.st.State = s
		require.Empty(t, m.EnrollmentQRPNG(), string(s))
	}
	m.st.State = StateEnrolling
	m.wipePairing()
	require.Empty(t, m.EnrollmentQRPNG(), "cancel/wipe ends image access")
}
